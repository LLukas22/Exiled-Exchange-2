use std::env;
use std::fmt;
use std::io::{self, Read, Write};
use std::process::ExitCode;
use std::slice;
use std::thread;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND};
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber,
    IsClipboardFormatAvailable, OpenClipboard, SetClipboardData,
};
use windows_sys::Win32::System::Memory::{
    GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, HWND_MESSAGE};

const READY_MARKER: &[u8] = b"EE2_CLIPBOARD_READY_V1\n";
const CF_UNICODETEXT: u32 = 13;
const STATIC_WINDOW_CLASS: &[u16] = &[
    b'S' as u16,
    b'T' as u16,
    b'A' as u16,
    b'T' as u16,
    b'I' as u16,
    b'C' as u16,
    0,
];
const CAPTURE_SIGNAL: u8 = b'G';
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(5);
const POLL_INTERVAL: Duration = Duration::from_millis(40);
const OPEN_RETRY_INTERVAL: Duration = Duration::from_millis(10);
const OPEN_ATTEMPTS: usize = 20;
const MAX_CAPTURE_BYTES: usize = 512 * 1024;
const MAX_RESTORE_BYTES: usize = 8 * 1024 * 1024;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(error.code)
        }
    }
}

fn run() -> Result<(), Failure> {
    let mut args = env::args_os().skip(1);
    if args.next().as_deref() != Some("--capture".as_ref()) {
        return Err(Failure::usage());
    }

    let restore = match args.next() {
        None => false,
        Some(arg) if arg == "--restore" => true,
        Some(_) => return Err(Failure::usage()),
    };
    if args.next().is_some() {
        return Err(Failure::usage());
    }

    capture(restore)
}

fn capture(restore_requested: bool) -> Result<(), Failure> {
    let owner = ClipboardOwner::new().map_err(Failure::prepare)?;
    let original = if restore_requested {
        clipboard_snapshot(&owner, MAX_RESTORE_BYTES).map_err(Failure::prepare)?
    } else {
        ClipboardSnapshot {
            sequence: clipboard_sequence(),
            text: None,
        }
    };

    if let Err(error) = write_ready_marker() {
        return Err(Failure::output(error));
    }
    wait_for_capture_signal().map_err(Failure::input)?;

    let deadline = Instant::now() + CAPTURE_TIMEOUT;
    let mut observed_sequence = original.sequence;
    let item = loop {
        if clipboard_sequence() != observed_sequence
            && let Ok(snapshot) = clipboard_snapshot(&owner, MAX_CAPTURE_BYTES)
        {
            observed_sequence = snapshot.sequence;
            if snapshot.text.as_deref().is_some_and(is_poe_item_text) {
                break Some(snapshot);
            }
        }

        if Instant::now() >= deadline {
            break None;
        }
        thread::sleep(POLL_INTERVAL);
    };

    if restore_requested {
        let current_sequence = clipboard_sequence();
        let restore_sequence = item
            .as_ref()
            .map(|captured| captured.sequence)
            .or_else(|| (current_sequence != original.sequence).then_some(current_sequence));
        if let Some(expected_sequence) = restore_sequence {
            restore_clipboard_if_unchanged(&owner, original.text.as_deref(), expected_sequence)
                .map_err(Failure::restore)?;
        }
    }

    let item = item
        .and_then(|snapshot| snapshot.text)
        .ok_or_else(Failure::not_found)?;
    if item.len() > MAX_CAPTURE_BYTES {
        return Err(Failure::prepare("captured clipboard text is too large"));
    }
    io::stdout()
        .write_all(item.as_bytes())
        .map_err(Failure::output)
}

fn write_ready_marker() -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    stdout.write_all(READY_MARKER)?;
    stdout.flush()
}

fn wait_for_capture_signal() -> Result<(), &'static str> {
    let mut signal = [0_u8; 1];
    io::stdin()
        .read_exact(&mut signal)
        .map_err(|_| "capture signal was not received")?;
    if signal[0] != CAPTURE_SIGNAL {
        return Err("capture signal was invalid");
    }
    Ok(())
}

struct ClipboardOwner(HWND);

impl ClipboardOwner {
    fn new() -> Result<Self, &'static str> {
        // SAFETY: STATIC is a system class, and all optional handles and data may be null.
        let window = unsafe {
            CreateWindowExW(
                0,
                STATIC_WINDOW_CLASS.as_ptr(),
                std::ptr::null(),
                0,
                0,
                0,
                0,
                0,
                HWND_MESSAGE,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        };
        if window.is_null() {
            return Err("could not create a private clipboard owner window");
        }
        Ok(Self(window))
    }
}

impl Drop for ClipboardOwner {
    fn drop(&mut self) {
        // SAFETY: This process created and exclusively owns the window.
        unsafe { DestroyWindow(self.0) };
    }
}

struct Clipboard;

impl Clipboard {
    fn open(owner: &ClipboardOwner) -> Result<Self, &'static str> {
        for attempt in 0..OPEN_ATTEMPTS {
            // SAFETY: The owner window remains alive and every successful open is closed.
            if unsafe { OpenClipboard(owner.0) } != 0 {
                return Ok(Self);
            }
            if attempt + 1 < OPEN_ATTEMPTS {
                thread::sleep(OPEN_RETRY_INTERVAL);
            }
        }
        Err("clipboard remained locked")
    }
}

impl Drop for Clipboard {
    fn drop(&mut self) {
        // SAFETY: This guard only exists after a successful OpenClipboard call.
        unsafe { CloseClipboard() };
    }
}

struct GlobalMemoryLock(HGLOBAL);

impl Drop for GlobalMemoryLock {
    fn drop(&mut self) {
        // SAFETY: The handle was successfully locked and remains valid while the clipboard is open.
        unsafe { GlobalUnlock(self.0) };
    }
}

struct OwnedGlobalMemory(Option<HGLOBAL>);

impl OwnedGlobalMemory {
    fn into_raw(mut self) -> HGLOBAL {
        self.0.take().unwrap_or(std::ptr::null_mut())
    }
}

impl Drop for OwnedGlobalMemory {
    fn drop(&mut self) {
        if let Some(handle) = self.0.take() {
            // SAFETY: SetClipboardData has not taken ownership of this handle.
            unsafe { GlobalFree(handle) };
        }
    }
}

struct ClipboardSnapshot {
    sequence: u32,
    text: Option<String>,
}

fn clipboard_sequence() -> u32 {
    // SAFETY: This function has no preconditions.
    unsafe { GetClipboardSequenceNumber() }
}

fn clipboard_snapshot(
    owner: &ClipboardOwner,
    max_bytes: usize,
) -> Result<ClipboardSnapshot, &'static str> {
    for _ in 0..3 {
        let before = clipboard_sequence();
        let text = read_clipboard(owner, max_bytes)?;
        let after = clipboard_sequence();
        if before == after {
            return Ok(ClipboardSnapshot {
                sequence: after,
                text,
            });
        }
    }
    Err("clipboard changed repeatedly while it was being read")
}

fn read_clipboard(
    owner: &ClipboardOwner,
    max_bytes: usize,
) -> Result<Option<String>, &'static str> {
    let _clipboard = Clipboard::open(owner)?;

    // SAFETY: Clipboard access is serialized by the Clipboard guard.
    if unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT) } == 0 {
        return Ok(None);
    }
    // SAFETY: Clipboard access is serialized and the returned handle is only read while open.
    let handle = unsafe { GetClipboardData(CF_UNICODETEXT) };
    if handle.is_null() {
        return Err("could not read Unicode clipboard data");
    }

    // SAFETY: CF_UNICODETEXT is backed by movable global memory.
    let byte_len = unsafe { GlobalSize(handle as HGLOBAL) };
    if byte_len < size_of::<u16>() || byte_len > max_bytes {
        return Err("Unicode clipboard data has an invalid size");
    }
    if byte_len % size_of::<u16>() != 0 {
        return Err("Unicode clipboard data has an invalid byte length");
    }

    // SAFETY: The clipboard owns this handle and keeps it valid until CloseClipboard.
    let pointer = unsafe { GlobalLock(handle as HGLOBAL) }.cast::<u16>();
    if pointer.is_null() {
        return Err("could not lock Unicode clipboard data");
    }
    let _lock = GlobalMemoryLock(handle as HGLOBAL);
    // SAFETY: GlobalSize bounded the allocation and the lock keeps it stable for this scope.
    let units = unsafe { slice::from_raw_parts(pointer, byte_len / size_of::<u16>()) };
    let terminator = units
        .iter()
        .position(|unit| *unit == 0)
        .ok_or("Unicode clipboard data is not null-terminated")?;
    String::from_utf16(&units[..terminator])
        .map(Some)
        .map_err(|_| "Unicode clipboard data contains invalid UTF-16")
}

fn restore_clipboard_if_unchanged(
    owner: &ClipboardOwner,
    text: Option<&str>,
    expected_sequence: u32,
) -> Result<(), &'static str> {
    let encoded = text.map(|value| {
        value
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>()
    });
    if encoded
        .as_ref()
        .is_some_and(|units| units.len() * size_of::<u16>() > MAX_RESTORE_BYTES)
    {
        return Err("Unicode clipboard data is too large");
    }

    let allocation = if let Some(units) = encoded {
        let byte_len = units.len() * size_of::<u16>();
        // SAFETY: The requested allocation size is bounded above and non-zero.
        let handle = unsafe { GlobalAlloc(GMEM_MOVEABLE, byte_len) };
        if handle.is_null() {
            return Err("could not allocate clipboard memory");
        }
        let allocation = OwnedGlobalMemory(Some(handle));
        // SAFETY: The handle was just allocated by this process.
        let pointer = unsafe { GlobalLock(handle) }.cast::<u16>();
        if pointer.is_null() {
            return Err("could not lock allocated clipboard memory");
        }
        // SAFETY: Both buffers contain units.len() u16 values and do not overlap.
        unsafe { std::ptr::copy_nonoverlapping(units.as_ptr(), pointer, units.len()) };
        // SAFETY: The preceding GlobalLock succeeded.
        unsafe { GlobalUnlock(handle) };
        Some(allocation)
    } else {
        None
    };

    let _clipboard = Clipboard::open(owner)?;
    if clipboard_sequence() != expected_sequence {
        return Ok(());
    }
    // SAFETY: Clipboard access is serialized by the Clipboard guard.
    if unsafe { EmptyClipboard() } == 0 {
        return Err("could not empty the clipboard");
    }

    let Some(allocation) = allocation else {
        return Ok(());
    };
    let handle = allocation.into_raw();

    // SAFETY: The clipboard is open and handle contains null-terminated UTF-16 data.
    if unsafe { SetClipboardData(CF_UNICODETEXT, handle as HANDLE) }.is_null() {
        // SAFETY: SetClipboardData did not take ownership when it failed.
        unsafe { GlobalFree(handle) };
        return Err("could not publish Unicode clipboard data");
    }
    Ok(())
}

fn is_poe_item_text(text: &str) -> bool {
    if text.is_empty() || text.len() > MAX_CAPTURE_BYTES {
        return false;
    }

    let mut lines = text.lines();
    let Some(first_line) = lines.next() else {
        return false;
    };
    if !first_line.contains(':') {
        return false;
    }

    let mut header_lines = usize::from(!first_line.is_empty());
    let mut saw_separator = false;
    let mut content_after_separator = false;
    for line in lines {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line == "--------" {
            saw_separator = true;
        } else if !line.is_empty() {
            if saw_separator {
                content_after_separator = true;
            } else {
                header_lines += 1;
            }
        }
    }

    header_lines >= 2 && saw_separator && content_after_separator
}

struct Failure {
    code: u8,
    message: String,
}

impl Failure {
    fn usage() -> Self {
        Self::new(7, "usage: ee2-win-clipboard.exe --capture [--restore]")
    }

    fn prepare(message: impl fmt::Display) -> Self {
        Self::new(2, format!("clipboard preparation failed: {message}"))
    }

    fn not_found() -> Self {
        Self::new(3, "no Path of Exile item text was captured")
    }

    fn restore(message: impl fmt::Display) -> Self {
        Self::new(4, format!("clipboard restoration failed: {message}"))
    }

    fn output(message: impl fmt::Display) -> Self {
        Self::new(5, format!("protocol output failed: {message}"))
    }

    fn input(message: impl fmt::Display) -> Self {
        Self::new(6, format!("protocol input failed: {message}"))
    }

    fn new(code: u8, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for Failure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn item_validation_accepts_crlf_item_text() {
        let text =
            "Item Class: Rings\r\nRarity: Rare\r\nExample\r\n--------\r\nRequirements:\r\nLevel: 1";
        assert!(is_poe_item_text(text));
    }

    #[test]
    fn item_validation_rejects_text_without_content() {
        let text = "Item Class: Rings\nRarity: Rare\n--------\n";
        assert!(!is_poe_item_text(text));
    }

    #[test]
    fn item_validation_rejects_oversized_text() {
        let text = "x".repeat(MAX_CAPTURE_BYTES + 1);
        assert!(!is_poe_item_text(&text));
    }
}

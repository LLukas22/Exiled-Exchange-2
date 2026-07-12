use libc::{c_int, c_ulong};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::env;
use std::ffi::CString;
use std::fs;
use std::io::{self, BufRead, Write};
use std::mem::{size_of, zeroed};
use std::os::fd::RawFd;
use std::process;
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_LINE_BYTES: usize = 1024 * 1024;
const PARENT_CHECK_INTERVAL: Duration = Duration::from_secs(60);
const LOOP_SLEEP: Duration = Duration::from_millis(4);
const KEY_CNT: usize = 0x300;
const ABS_CNT: usize = 0x40;

const EV_SYN: u16 = 0x00;
const EV_KEY: u16 = 0x01;
const SYN_REPORT: u16 = 0;

const KEY_LEFTCTRL: i32 = 29;
const KEY_LEFTSHIFT: i32 = 42;
const KEY_LEFTALT: i32 = 56;
const KEY_RIGHTCTRL: i32 = 97;
const KEY_RIGHTSHIFT: i32 = 54;
const KEY_RIGHTALT: i32 = 100;
const KEY_LEFTMETA: i32 = 125;
const KEY_RIGHTMETA: i32 = 126;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    parent_pid: i32,
    devices: Vec<String>,
    hotkeys: Vec<HotkeyConfig>,
    enable_uinput: bool,
}

#[derive(Clone, Debug, Deserialize)]
struct HotkeyConfig {
    id: String,
    accelerator: String,
    parsed: ParsedHotkey,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParsedHotkey {
    key_code: String,
    modifiers: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum Command {
    #[serde(rename = "bind")]
    Bind { hotkey: HotkeyConfig },
    #[serde(rename = "unbind")]
    Unbind { id: String },
    #[serde(rename = "clear")]
    Clear,
    #[serde(rename = "set")]
    Set { hotkeys: Vec<HotkeyConfig> },
    #[serde(rename = "copy")]
    Copy {
        #[serde(rename = "requestId")]
        request_id: String,
        accelerator: String,
    },
    #[serde(rename = "exit")]
    Exit,
    #[serde(rename = "shutdown")]
    Shutdown,
}

#[derive(Clone, Copy, Debug, Default)]
struct Modifiers {
    ctrl: bool,
    shift: bool,
    alt: bool,
    meta: bool,
}

#[derive(Clone, Debug)]
struct Hotkey {
    id: String,
    accelerator: String,
    key_code: i32,
    required: Modifiers,
}

struct Device {
    path: String,
    fd: RawFd,
}

struct UinputDevice {
    fd: RawFd,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct InputId {
    bustype: u16,
    vendor: u16,
    product: u16,
    version: u16,
}

#[repr(C)]
struct UinputUserDev {
    name: [u8; 80],
    id: InputId,
    ff_effects_max: u32,
    absmax: [i32; ABS_CNT],
    absmin: [i32; ABS_CNT],
    absfuzz: [i32; ABS_CNT],
    absflat: [i32; ABS_CNT],
}

#[repr(C)]
#[derive(Clone, Copy)]
struct TimeVal {
    tv_sec: libc::time_t,
    tv_usec: libc::suseconds_t,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct InputEvent {
    time: TimeVal,
    type_: u16,
    code: u16,
    value: i32,
}

impl Drop for Device {
    fn drop(&mut self) {
        unsafe { libc::close(self.fd) };
    }
}

impl Drop for UinputDevice {
    fn drop(&mut self) {
        unsafe {
            libc::ioctl(self.fd, ui_dev_destroy());
            libc::close(self.fd);
        }
    }
}

fn main() {
    if let Err(error) = run() {
        let _ = emit_error("HELPER_FAILED", &error.to_string(), None);
        process::exit(1);
    }
}

fn run() -> io::Result<()> {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("--version") => {
            println!("ee2-wayland-helper {}", env!("CARGO_PKG_VERSION"));
            return Ok(());
        }
        Some("--health-check") => {
            emit_health_check()?;
            return Ok(());
        }
        Some(arg) => {
            emit_error(
                "ARGUMENT_UNSUPPORTED",
                &format!("unsupported argument: {arg}"),
                None,
            )?;
            return Ok(());
        }
        None => {}
    }

    let config = read_config()?;
    let mut devices = open_devices(&config.devices)?;
    let mut hotkeys = parse_hotkeys(&config.hotkeys)?;
    let uinput = if config.enable_uinput {
        Some(UinputDevice::create()?)
    } else {
        None
    };
    let commands = spawn_command_reader();
    let mut key_counts = vec![0i32; KEY_CNT];
    let mut last_parent_check = Instant::now() - PARENT_CHECK_INTERVAL;

    emit_json(&json!({
        "type": "ready",
        "version": env!("CARGO_PKG_VERSION"),
        "pid": process::id(),
        "devices": devices.iter().map(|device| &device.path).collect::<Vec<_>>(),
        "hotkeys": hotkeys.len(),
        "supports": { "evdev": true, "uinput": uinput.is_some() }
    }))?;

    loop {
        while let Ok(command) = commands.try_recv() {
            match command {
                Command::Bind { hotkey } => {
                    bind_hotkey(&mut hotkeys, parse_hotkey(&hotkey)?);
                    emit_configured(hotkeys.len())?;
                }
                Command::Unbind { id } => {
                    hotkeys.retain(|hotkey| hotkey.id != id);
                    emit_configured(hotkeys.len())?;
                }
                Command::Clear => {
                    hotkeys.clear();
                    emit_configured(0)?;
                }
                Command::Set { hotkeys: next } => {
                    hotkeys = parse_hotkeys(&next)?;
                    emit_configured(hotkeys.len())?;
                }
                Command::Copy {
                    request_id,
                    accelerator,
                } => match &uinput {
                    Some(device) => {
                        if let Err(error) = device.copy_accelerator(&accelerator) {
                            emit_error("COPY_FAILED", &error.to_string(), Some(&request_id))?;
                        } else {
                            emit_json(&json!({
                                "type": "copied",
                                "requestId": request_id,
                                "accelerator": accelerator,
                                "timestamp": now_ms()
                            }))?;
                        }
                    }
                    None => emit_error(
                        "UINPUT_DISABLED",
                        "uinput is not enabled",
                        Some(&request_id),
                    )?,
                },
                Command::Exit | Command::Shutdown => {
                    emit_json(&json!({ "type": "exit", "reason": "requested" }))?;
                    return Ok(());
                }
            }
        }

        for device in &mut devices {
            read_device_events(device, &mut key_counts, &hotkeys)?;
        }

        if last_parent_check.elapsed() >= PARENT_CHECK_INTERVAL {
            last_parent_check = Instant::now();
            if !parent_is_alive(config.parent_pid) {
                return Ok(());
            }
        }

        thread::sleep(LOOP_SLEEP);
    }
}

fn read_config() -> io::Result<Config> {
    let stdin = io::stdin();
    let mut line = String::new();
    stdin.lock().read_line(&mut line)?;
    if line.len() > MAX_LINE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "config exceeded maximum size",
        ));
    }
    serde_json::from_str(&line).map_err(invalid_data)
}

fn spawn_command_reader() -> Receiver<Command> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            if line.len() > MAX_LINE_BYTES {
                let _ = emit_error("COMMAND_TOO_LARGE", "command exceeded maximum size", None);
                continue;
            }
            match serde_json::from_str::<Command>(&line) {
                Ok(command) => {
                    if tx.send(command).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    let _ = emit_error("COMMAND_INVALID", &error.to_string(), None);
                }
            }
        }
    });
    rx
}

fn open_devices(paths: &[String]) -> io::Result<Vec<Device>> {
    let mut devices = Vec::with_capacity(paths.len());
    for path in paths {
        let c_path = CString::new(path.as_str()).map_err(invalid_data)?;
        let fd = unsafe {
            libc::open(
                c_path.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        devices.push(Device {
            path: path.clone(),
            fd,
        });
    }
    Ok(devices)
}

fn read_device_events(
    device: &mut Device,
    key_counts: &mut [i32],
    hotkeys: &[Hotkey],
) -> io::Result<()> {
    loop {
        let mut event = unsafe { zeroed::<InputEvent>() };
        let read = unsafe {
            libc::read(
                device.fd,
                (&mut event as *mut InputEvent).cast(),
                size_of::<InputEvent>(),
            )
        };

        if read == size_of::<InputEvent>() as isize {
            if event.type_ == EV_KEY {
                handle_key_event(key_counts, hotkeys, i32::from(event.code), event.value)?;
            }
            continue;
        }

        if read < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::WouldBlock {
                return Ok(());
            }
            return Err(error);
        }

        if read == 0 {
            return Ok(());
        }

        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            format!("short read from {}", device.path),
        ));
    }
}

fn handle_key_event(
    key_counts: &mut [i32],
    hotkeys: &[Hotkey],
    code: i32,
    value: i32,
) -> io::Result<()> {
    if value == 2 {
        return Ok(());
    }
    if value == 0 {
        update_key_counts(key_counts, code, value);
        return Ok(());
    }
    if value != 1 {
        return Ok(());
    }

    update_key_counts(key_counts, code, value);
    let current = current_modifiers(key_counts);

    for hotkey in hotkeys {
        if hotkey.key_code == code && modifiers_match(current, hotkey.required) {
            emit_json(&json!({
                "type": "hotkey",
                "id": hotkey.id,
                "accelerator": hotkey.accelerator,
                "timestamp": now_ms()
            }))?;
        }
    }
    Ok(())
}

fn update_key_counts(key_counts: &mut [i32], code: i32, value: i32) {
    let Ok(index) = usize::try_from(code) else {
        return;
    };
    let Some(count) = key_counts.get_mut(index) else {
        return;
    };
    if value == 1 {
        *count += 1;
    } else if value == 0 && *count > 0 {
        *count -= 1;
    }
}

fn current_modifiers(key_counts: &[i32]) -> Modifiers {
    Modifiers {
        ctrl: key_pressed(key_counts, KEY_LEFTCTRL) || key_pressed(key_counts, KEY_RIGHTCTRL),
        shift: key_pressed(key_counts, KEY_LEFTSHIFT) || key_pressed(key_counts, KEY_RIGHTSHIFT),
        alt: key_pressed(key_counts, KEY_LEFTALT) || key_pressed(key_counts, KEY_RIGHTALT),
        meta: key_pressed(key_counts, KEY_LEFTMETA) || key_pressed(key_counts, KEY_RIGHTMETA),
    }
}

fn key_pressed(key_counts: &[i32], code: i32) -> bool {
    usize::try_from(code)
        .ok()
        .and_then(|index| key_counts.get(index))
        .is_some_and(|count| *count > 0)
}

fn modifiers_match(current: Modifiers, required: Modifiers) -> bool {
    (!required.ctrl || current.ctrl)
        && (!required.shift || current.shift)
        && (!required.alt || current.alt)
        && (!required.meta || current.meta)
}

fn parse_hotkeys(configs: &[HotkeyConfig]) -> io::Result<Vec<Hotkey>> {
    configs.iter().map(parse_hotkey).collect()
}

fn parse_hotkey(config: &HotkeyConfig) -> io::Result<Hotkey> {
    Ok(Hotkey {
        id: config.id.clone(),
        accelerator: config.accelerator.clone(),
        key_code: key_code_from_name(&config.parsed.key_code)?,
        required: parse_modifiers(&config.parsed.modifiers)?,
    })
}

fn bind_hotkey(hotkeys: &mut Vec<Hotkey>, hotkey: Hotkey) {
    if let Some(existing) = hotkeys.iter_mut().find(|existing| existing.id == hotkey.id) {
        *existing = hotkey;
    } else {
        hotkeys.push(hotkey);
    }
}

fn parse_modifiers(modifiers: &[String]) -> io::Result<Modifiers> {
    let mut parsed = Modifiers::default();
    for modifier in modifiers {
        match modifier.as_str() {
            "ctrl" => parsed.ctrl = true,
            "shift" => parsed.shift = true,
            "alt" => parsed.alt = true,
            "meta" => parsed.meta = true,
            _ => return Err(invalid_data(format!("unsupported modifier: {modifier}"))),
        }
    }
    Ok(parsed)
}

impl UinputDevice {
    fn create() -> io::Result<Self> {
        let fd = open_uinput()?;
        let device = Self { fd };

        device.ioctl_int(ui_set_evbit(), i32::from(EV_KEY))?;
        device.ioctl_int(ui_set_evbit(), i32::from(EV_SYN))?;
        for code in all_uinput_key_codes() {
            device.ioctl_int(ui_set_keybit(), code)?;
        }

        let mut uidev = unsafe { zeroed::<UinputUserDev>() };
        let name = b"EE2 Wayland Helper\0";
        uidev.name[..name.len()].copy_from_slice(name);
        uidev.id = InputId {
            bustype: 0x03,
            vendor: 0x4558,
            product: 0x0002,
            version: 1,
        };

        device.write_all_bytes(bytes_of(&uidev))?;
        device.ioctl(ui_dev_create())?;
        thread::sleep(Duration::from_millis(100));
        Ok(device)
    }

    fn copy_accelerator(&self, accelerator: &str) -> io::Result<()> {
        let keys = parse_accelerator_codes(accelerator)?;
        for &code in &keys.modifiers {
            self.emit_key(code, 1)?;
        }
        self.emit_key(keys.key, 1)?;
        self.emit_key(keys.key, 0)?;
        for &code in keys.modifiers.iter().rev() {
            self.emit_key(code, 0)?;
        }
        Ok(())
    }

    fn emit_key(&self, code: i32, value: i32) -> io::Result<()> {
        self.write_event(EV_KEY, u16::try_from(code).map_err(invalid_data)?, value)?;
        self.write_event(EV_SYN, SYN_REPORT, 0)
    }

    fn write_event(&self, type_: u16, code: u16, value: i32) -> io::Result<()> {
        let event = InputEvent {
            time: TimeVal {
                tv_sec: 0,
                tv_usec: 0,
            },
            type_,
            code,
            value,
        };
        self.write_all_bytes(bytes_of(&event))
    }

    fn write_all_bytes(&self, mut bytes: &[u8]) -> io::Result<()> {
        while !bytes.is_empty() {
            let written = unsafe { libc::write(self.fd, bytes.as_ptr().cast(), bytes.len()) };
            if written < 0 {
                return Err(io::Error::last_os_error());
            }
            let written = usize::try_from(written).map_err(invalid_data)?;
            bytes = &bytes[written..];
        }
        Ok(())
    }

    fn ioctl(&self, request: c_ulong) -> io::Result<()> {
        let result = unsafe { libc::ioctl(self.fd, request) };
        if result < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    fn ioctl_int(&self, request: c_ulong, value: c_int) -> io::Result<()> {
        let result = unsafe { libc::ioctl(self.fd, request, value) };
        if result < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

struct AcceleratorCodes {
    modifiers: Vec<i32>,
    key: i32,
}

fn parse_accelerator_codes(accelerator: &str) -> io::Result<AcceleratorCodes> {
    let mut modifiers = Vec::new();
    let mut key = None;
    for part in accelerator.split('+') {
        let part = part.trim();
        match part {
            "Ctrl" | "Control" => modifiers.push(KEY_LEFTCTRL),
            "Shift" => modifiers.push(KEY_LEFTSHIFT),
            "Alt" => modifiers.push(KEY_LEFTALT),
            "Meta" | "Super" => modifiers.push(KEY_LEFTMETA),
            _ => key = Some(key_code_from_accelerator_part(part)?),
        }
    }

    Ok(AcceleratorCodes {
        modifiers,
        key: key.ok_or_else(|| invalid_data("accelerator is missing a non-modifier key"))?,
    })
}

fn all_uinput_key_codes() -> Vec<i32> {
    let mut codes = vec![
        KEY_LEFTCTRL,
        KEY_LEFTSHIFT,
        KEY_LEFTALT,
        KEY_LEFTMETA,
        KEY_RIGHTCTRL,
        KEY_RIGHTSHIFT,
        KEY_RIGHTALT,
        KEY_RIGHTMETA,
    ];
    codes.extend(
        (b'A'..=b'Z')
            .filter_map(|letter| key_code_from_name(&format!("KEY_{}", letter as char)).ok()),
    );
    codes
}

fn open_uinput() -> io::Result<RawFd> {
    for path in ["/dev/uinput", "/dev/input/uinput"] {
        let c_path = CString::new(path).map_err(invalid_data)?;
        let fd = unsafe {
            libc::open(
                c_path.as_ptr(),
                libc::O_WRONLY | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd >= 0 {
            return Ok(fd);
        }
    }
    Err(io::Error::last_os_error())
}

fn parent_is_alive(parent_pid: i32) -> bool {
    let result = unsafe { libc::kill(parent_pid, 0) };
    result == 0 || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

fn emit_health_check() -> io::Result<()> {
    let uinput_available = fs::metadata("/dev/uinput")
        .or_else(|_| fs::metadata("/dev/input/uinput"))
        .is_ok();
    emit_json(&json!({
        "type": "health",
        "version": env!("CARGO_PKG_VERSION"),
        "pid": process::id(),
        "supports": { "evdev": true, "uinput": uinput_available }
    }))
}

fn emit_configured(hotkeys: usize) -> io::Result<()> {
    emit_json(&json!({ "type": "configured", "hotkeys": hotkeys }))
}

fn emit_error(code: &str, message: &str, request_id: Option<&str>) -> io::Result<()> {
    let mut event = json!({ "type": "error", "code": code, "message": message });
    if let Some(request_id) = request_id {
        event["requestId"] = json!(request_id);
    }
    emit_json(&event)
}

fn emit_json(value: &serde_json::Value) -> io::Result<()> {
    let stdout = io::stdout();
    let mut stdout = stdout.lock();
    serde_json::to_writer(&mut stdout, value).map_err(io::Error::other)?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis())
}

fn invalid_data(error: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error.to_string())
}

fn bytes_of<T>(value: &T) -> &[u8] {
    unsafe { std::slice::from_raw_parts((value as *const T).cast(), size_of::<T>()) }
}

const fn ioc(dir: u64, type_: u64, nr: u64, size: u64) -> c_ulong {
    const NRSHIFT: u64 = 0;
    const TYPESHIFT: u64 = 8;
    const SIZESHIFT: u64 = 16;
    const DIRSHIFT: u64 = 30;
    ((dir << DIRSHIFT) | (type_ << TYPESHIFT) | (nr << NRSHIFT) | (size << SIZESHIFT)) as c_ulong
}

const fn iow(type_: u8, nr: u8, size: usize) -> c_ulong {
    ioc(1, type_ as u64, nr as u64, size as u64)
}

const fn ui_set_evbit() -> c_ulong {
    iow(b'U', 100, size_of::<c_int>())
}

const fn ui_set_keybit() -> c_ulong {
    iow(b'U', 101, size_of::<c_int>())
}

const fn ui_dev_create() -> c_ulong {
    ioc(0, b'U' as u64, 1, 0)
}

const fn ui_dev_destroy() -> c_ulong {
    ioc(0, b'U' as u64, 2, 0)
}

fn key_code_from_accelerator_part(part: &str) -> io::Result<i32> {
    let key_name = match part {
        "Space" => "KEY_SPACE".to_string(),
        "Escape" => "KEY_ESC".to_string(),
        "ArrowUp" => "KEY_UP".to_string(),
        "ArrowDown" => "KEY_DOWN".to_string(),
        "ArrowLeft" => "KEY_LEFT".to_string(),
        "ArrowRight" => "KEY_RIGHT".to_string(),
        "PageUp" => "KEY_PAGEUP".to_string(),
        "PageDown" => "KEY_PAGEDOWN".to_string(),
        "NumpadAdd" => "KEY_KPPLUS".to_string(),
        "NumpadSubtract" => "KEY_KPMINUS".to_string(),
        "NumpadMultiply" => "KEY_KPASTERISK".to_string(),
        "NumpadDivide" => "KEY_KPSLASH".to_string(),
        "NumpadDecimal" => "KEY_KPDOT".to_string(),
        key if key.len() == 1 && key.as_bytes()[0].is_ascii_alphabetic() => {
            format!("KEY_{}", key.to_ascii_uppercase())
        }
        key => format!("KEY_{}", key.to_ascii_uppercase()),
    };
    key_code_from_name(&key_name)
}

fn key_code_from_name(name: &str) -> io::Result<i32> {
    if let Some(code) = key_code_map().get(name) {
        Ok(*code)
    } else {
        Err(invalid_data(format!("unsupported key code: {name}")))
    }
}

fn key_code_map() -> HashMap<&'static str, i32> {
    HashMap::from([
        ("KEY_A", 30),
        ("KEY_B", 48),
        ("KEY_C", 46),
        ("KEY_D", 32),
        ("KEY_E", 18),
        ("KEY_F", 33),
        ("KEY_G", 34),
        ("KEY_H", 35),
        ("KEY_I", 23),
        ("KEY_J", 36),
        ("KEY_K", 37),
        ("KEY_L", 38),
        ("KEY_M", 50),
        ("KEY_N", 49),
        ("KEY_O", 24),
        ("KEY_P", 25),
        ("KEY_Q", 16),
        ("KEY_R", 19),
        ("KEY_S", 31),
        ("KEY_T", 20),
        ("KEY_U", 22),
        ("KEY_V", 47),
        ("KEY_W", 17),
        ("KEY_X", 45),
        ("KEY_Y", 21),
        ("KEY_Z", 44),
        ("KEY_0", 11),
        ("KEY_1", 2),
        ("KEY_2", 3),
        ("KEY_3", 4),
        ("KEY_4", 5),
        ("KEY_5", 6),
        ("KEY_6", 7),
        ("KEY_7", 8),
        ("KEY_8", 9),
        ("KEY_9", 10),
        ("KEY_F1", 59),
        ("KEY_F2", 60),
        ("KEY_F3", 61),
        ("KEY_F4", 62),
        ("KEY_F5", 63),
        ("KEY_F6", 64),
        ("KEY_F7", 65),
        ("KEY_F8", 66),
        ("KEY_F9", 67),
        ("KEY_F10", 68),
        ("KEY_F11", 87),
        ("KEY_F12", 88),
        ("KEY_SPACE", 57),
        ("KEY_TAB", 15),
        ("KEY_HOME", 102),
        ("KEY_END", 107),
        ("KEY_PAGEUP", 104),
        ("KEY_PAGEDOWN", 109),
        ("KEY_INSERT", 110),
        ("KEY_DELETE", 111),
        ("KEY_ESC", 1),
        ("KEY_ENTER", 28),
        ("KEY_BACKSPACE", 14),
        ("KEY_DOT", 52),
        ("KEY_UP", 103),
        ("KEY_DOWN", 108),
        ("KEY_LEFT", 105),
        ("KEY_RIGHT", 106),
        ("KEY_KP0", 82),
        ("KEY_KP1", 79),
        ("KEY_KP2", 80),
        ("KEY_KP3", 81),
        ("KEY_KP4", 75),
        ("KEY_KP5", 76),
        ("KEY_KP6", 77),
        ("KEY_KP7", 71),
        ("KEY_KP8", 72),
        ("KEY_KP9", 73),
        ("KEY_KPPLUS", 78),
        ("KEY_KPMINUS", 74),
        ("KEY_KPASTERISK", 55),
        ("KEY_KPSLASH", 98),
        ("KEY_KPENTER", 96),
        ("KEY_KPDOT", 83),
        ("BTN_LEFT", 272),
        ("BTN_RIGHT", 273),
        ("BTN_MIDDLE", 274),
        ("BTN_SIDE", 275),
        ("BTN_EXTRA", 276),
    ])
}

use std::env;
use std::io::{self, BufRead, Write};
use std::process;

const MAX_LINE_BYTES: usize = 1024 * 1024;

fn main() {
    if let Err(error) = run() {
        let _ = emit_error("HELPER_FAILED", &error.to_string());
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
            )?;
            return Ok(());
        }
        None => {}
    }

    emit_ready()?;

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.len() > MAX_LINE_BYTES {
            emit_error("COMMAND_TOO_LARGE", "command exceeded maximum size")?;
            continue;
        }

        if is_exit_command(&line) {
            emit_exiting()?;
            return Ok(());
        }

        emit_error(
            "COMMAND_UNSUPPORTED",
            "runtime command type is not implemented yet",
        )?;
    }

    Ok(())
}

fn is_exit_command(line: &str) -> bool {
    line.contains("\"type\":\"exit\"") || line.contains("\"type\":\"shutdown\"")
}

fn emit_health_check() -> io::Result<()> {
    emit_json_line(&format!(
        "{{\"type\":\"health\",\"version\":{},\"pid\":{},\"supports\":{{\"evdev\":false,\"uinput\":false}}}}",
        json_string(env!("CARGO_PKG_VERSION")),
        process::id()
    ))
}

fn emit_ready() -> io::Result<()> {
    emit_json_line(&format!(
        "{{\"type\":\"ready\",\"version\":{},\"pid\":{},\"supports\":{{\"evdev\":false,\"uinput\":false}}}}",
        json_string(env!("CARGO_PKG_VERSION")),
        process::id()
    ))
}

fn emit_exiting() -> io::Result<()> {
    emit_json_line("{\"type\":\"exit\",\"reason\":\"requested\"}")
}

fn emit_error(code: &str, message: &str) -> io::Result<()> {
    emit_json_line(&format!(
        "{{\"type\":\"error\",\"code\":{},\"message\":{}}}",
        json_string(code),
        json_string(message)
    ))
}

fn emit_json_line(line: &str) -> io::Result<()> {
    let stdout = io::stdout();
    let mut stdout = stdout.lock();
    stdout.write_all(line.as_bytes())?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}

fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if ch.is_control() => out.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}

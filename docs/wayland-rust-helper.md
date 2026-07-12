# Wayland Rust Helper

EE2 can bundle its own native Wayland helper with the Electron app. The helper
lives at `main/native/ee2-wayland-helper` and is built by `main/build/script.mjs`
on Linux.

The build copies the compiled binary to `main/dist/native/ee2-wayland-helper`.
`electron-builder` then packages it as `native/ee2-wayland-helper` and unpacks it
outside `app.asar`, which is required for direct execution and future `pkexec`
use.

Current state:

- The Rust helper is the Wayland hotkey backend.
- It supports `--version` and `--health-check`.
- It emits NDJSON events on stdout.
- It reads configured evdev devices and emits only registered hotkey events.
- It creates a narrow uinput keyboard and accepts a `copy` command for the Path
  of Exile item-copy key combo.

The `copy-item` action starts clipboard polling, then asks the helper to send the
copy combo through uinput. This replaces the old Wayland path where hotkey input
used evdev but copy output still used X11/XTEST via `uIOhook`, causing
`No item text found` timeouts.

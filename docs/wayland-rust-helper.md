# Wayland Rust Helper

EE2 can bundle its own native Wayland helper with the Electron app. The helper
lives at `main/native/ee2-wayland-helper` and is built by `main/build/script.mjs`
on Linux.

The build copies the compiled binary to `main/dist/native/ee2-wayland-helper`.
`electron-builder` then packages it as `native/ee2-wayland-helper` and unpacks it
outside `app.asar`, which is required for direct execution and future `pkexec`
use.

Current state:

- EE2 tries the XDG Desktop Portal GlobalShortcuts API first for Wayland hotkey
  capture.
- If the portal is unavailable, denied, or fails to bind shortcuts, EE2 falls
  back to the Rust evdev backend.
- It supports `--version` and `--health-check`.
- It emits NDJSON events on stdout.
- It reads configured evdev devices and emits only registered hotkey events.
- It creates a narrow uinput keyboard and accepts a `copy` command for the Path
  of Exile item-copy key combo.

The `copy-item` action starts clipboard polling, then asks the helper to send the
copy combo through uinput. The portal can safely report global shortcut
activation, but it cannot synthesize `Ctrl+C` into Path of Exile, so the uinput
copy path is still required for one-key price checks.

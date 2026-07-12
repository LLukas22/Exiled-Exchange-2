# Wayland Rust Helper

EE2 can bundle its own native Wayland helper with the Electron app. The helper
lives at `main/native/ee2-wayland-helper` and is built by `main/build/script.mjs`
on Linux.

The build copies the compiled binary to `main/dist/native/ee2-wayland-helper`.
`electron-builder` then packages it as `native/ee2-wayland-helper` and unpacks it
outside `app.asar`, which is required for direct execution and future `pkexec`
use.

Current state:

- The Rust helper is a protocol scaffold only.
- It supports `--version` and `--health-check`.
- It emits NDJSON events on stdout.
- Evdev capture and uinput copy injection are intentionally not implemented yet.

Next implementation target: add a narrow uinput command that sends the Path of
Exile item-copy key combo on Wayland, then route `copy-item` actions through this
helper instead of `uIOhook`.

# Electron BrowserWindow API on Wayland — Reference for EE2 Overlay

Traced against Electron (Chromium 151.0.7894.0) source at
`~/Sources/electron`. All file references are relative to that repo.

---

## Method-by-method trace

### `show()`

**Source:** `shell/browser/native_window_views.cc:587`

```cpp
void NativeWindowViews::Show() {
  widget()->native_widget_private()->Show(GetRestoredState(), gfx::Rect());
  widget()->Activate();   // explicit activation request
  NotifyWindowShow();
  if (x11_util::IsX11())
    widget()->SetZOrderLevel(widget()->GetZOrderLevel());
}
```

`widget()->Activate()` calls `platform_window()->Activate()`, which on Wayland
issues an `xdg_activation_v1` token request to the compositor. Whether the
compositor grants focus is up to it. KWin honors the request only when it
considers the token valid (i.e., it originated from a genuine user interaction
event on the current active surface). Activation requests that arrive without a
compositor-endorsed token may be silently ignored or cause KWin to flash the
taskbar entry instead.

**Official docs note:** "On Wayland (Linux), the desktop environment may show
a notification or flash the app icon if the window or app is not already
focused."

**Verdict:** Works on Wayland. Maps the surface and requests focus. Whether
focus is granted depends on compositor focus-stealing prevention policy. Do
not use `show()` when you want the overlay to appear without disturbing the
focused game — see the EE2 pattern below.

---

### `showInactive()`

**Source:** `shell/browser/native_window_views.cc:609`

```cpp
void NativeWindowViews::ShowInactive() {
  widget()->ShowInactive();   // no Activate() call
  NotifyWindowShow();
  if (x11_util::IsX11())
    widget()->SetZOrderLevel(widget()->GetZOrderLevel());
}
```

Unlike `Show()`, this does not call `Activate()`. The intent is to map the
window surface without requesting focus.

**Official docs:** `win.showInactive()` — **"Not supported on Wayland (Linux)."**

On Wayland the behavior is undefined. There is no `xdg_toplevel` protocol
equivalent of X11's `_NET_WM_USER_TIME` suppress-activation hint. In practice
the window may map without focus or may behave identically to `show()`.

**Verdict:** Officially unsupported. Behavior is undefined on Wayland. Do not
rely on it.

---

### `focus()`

**Source:** `shell/browser/native_window_views.cc:571`

```cpp
void NativeWindowViews::Focus(bool focus) {
  if (!IsVisible()) return;   // no-op if window is hidden
  if (focus) {
    widget()->Activate();
  } else {
    widget()->Deactivate();
  }
}
```

**Critical guard:** `focus()` is a silent no-op if the window is not yet
visible. Always call `show()` first.

On Wayland, `Activate()` sends another `xdg_activation_v1` request. Against a
fullscreen game, KWin either denies it (overlay stays unfocused) or briefly
grants it (game immediately fights to reclaim focus). Either outcome is wrong
for an overlay that is supposed to sit passively on top of a running game.

**Verdict:** Functionally works on Wayland when the window is visible. Do NOT
use it in a game overlay context — it sends a compositor activation request
that creates a focus battle with the game. See EE2 findings below.

---

### `hide()`

**Source:** `shell/browser/native_window_views.cc:625`

```cpp
void NativeWindowViews::Hide() {
  widget()->Hide();
  NotifyWindowHide();
}
```

Clean, no platform guards. Unmaps the Wayland surface. The compositor returns
keyboard focus to whichever window previously held it.

**Verdict:** Works correctly on Wayland. The preferred close mechanism for an
overlay.

---

### `moveTop()`

**Source:** `shell/browser/native_window_views.cc:1035`

```cpp
void NativeWindowViews::MoveTop() {
  // TODO(julien.isorce): fix chromium in order to use existing widget()->StackAtTop().
#if BUILDFLAG(IS_WIN)
  ::SetWindowPos(..., SWP_NOACTIVATE | ...);
#else
  if (x11_util::IsX11())
    electron::MoveWindowToForeground(static_cast<x11::Window>(...));
#endif
}
```

The Wayland branch is entirely absent.

**Official docs:** `win.moveTop()` — **"Not supported on Wayland (Linux)."**

**Verdict:** Confirmed no-op on Wayland.

---

### `setAlwaysOnTop(true, level)`

**Source:** `shell/browser/api/electron_api_base_window.cc:569`,
`shell/browser/native_window_views.cc:1169`

```cpp
void BaseWindow::SetAlwaysOnTop(bool top, gin::Arguments* args) {
  std::string level = "floating";
  ui::ZOrderLevel z_order =
      top ? ui::ZOrderLevel::kFloatingWindow : ui::ZOrderLevel::kNormal;
  window_->SetAlwaysOnTop(z_order, level, relative_level);
}

void NativeWindowViews::SetAlwaysOnTop(
    const ui::ZOrderLevel z_order,
    const std::string& level,
    const int relativeLevel) {
  widget()->SetZOrderLevel(z_order);
  // level string only used for Windows behind_task_bar_ logic
}
```

**The `level` parameter (`"screen-saver"` etc.) is `_macOS_ _Windows_` only.**
On Linux the string is silently discarded. All truthy level values map
identically to `ui::ZOrderLevel::kFloatingWindow`.

`widget()->SetZOrderLevel(kFloatingWindow)` goes through Chromium's ozone
layer to the Wayland platform window. The compositor effect is undefined —
there is no `zwlr_layer_shell_v1` in use.

**Official docs:** `win.setAlwaysOnTop()` — **"Not supported on Wayland (Linux)."**

**Verdict:** Level string has no effect on Linux. The boolean may produce a
compositor-dependent stacking hint. Set it once at window creation and do not
toggle it on every show/hide: each `SetZOrderLevel` call routes to the platform
window and may trigger a compositor recompositing cycle, which on some versions
of KWin manifests as a brief focus change.

---

### `setVisibleOnAllWorkspaces(true)`

**Source:** `shell/browser/api/electron_api_base_window.cc:817`,
`shell/browser/native_window_views.cc:1681`

```cpp
void NativeWindowViews::SetVisibleOnAllWorkspaces(
    bool visible,
    bool visibleOnFullScreen,
    bool skipTransformProcessType) {
  widget()->SetVisibleOnAllWorkspaces(visible);
  // visibleOnFullScreen and skipTransformProcessType silently ignored on Linux
}
```

**`visibleOnFullScreen: true` is `_macOS_` only.** On Linux the option is
accepted at the JS layer and discarded before the native call. The `visible`
boolean does have effect on Wayland via whatever sticky-workspace protocol the
compositor supports.

**Verdict:** Works on Linux. The boolean is operative. The `visibleOnFullScreen`
option does nothing on Linux — omit it or pass it for macOS compatibility only.

---

### `setIgnoreMouseEvents(bool)`

**Source:** `shell/browser/native_window_views.cc:1371`

```cpp
void NativeWindowViews::SetIgnoreMouseEvents(bool ignore, bool forward) {
#if BUILDFLAG(IS_WIN)
  // WS_EX_TRANSPARENT | WS_EX_LAYERED
#else
  if (x11_util::IsX11()) {
    // X11 Shape extension — sets a 1x1 input region
  }
#endif
}
```

The Wayland branch is entirely absent.

**Verdict:** Confirmed no-op on Wayland. Mouse passthrough cannot be controlled
from Electron on Wayland. Surface visibility (`hide()`) is the only available
input suppression mechanism.

---

### `globalShortcut.register()` on Wayland

`globalShortcut` is not a BrowserWindow method but its behavior on Wayland is
critical for EE2.

On a Wayland session that includes XWayland (which PoE2 runs under), Electron's
`globalShortcut.register()` falls back to `XGrabKey` on the X11 display.
`XGrabKey` temporarily diverts the grabbed keys away from the focused XWayland
window and can disrupt PoE2's own input handling.

**Verdict:** Do not call `globalShortcut.register()` on Wayland. EE2 registers
actions with the XDG GlobalShortcuts portal. Hyprland users bind the resulting
portal action IDs in their compositor configuration.

---

## Summary table

| API | Wayland status | Notes |
|-----|---------------|-------|
| `show()` | Works | Requests focus via xdg_activation_v1; may fight fullscreen game |
| `showInactive()` | **Not supported** | Officially unsupported; undefined behavior |
| `focus()` | Works (if visible) | Sends activation request; causes focus battle with fullscreen game |
| `hide()` | Works | Clean surface unmap; compositor returns focus to previous window |
| `moveTop()` | **No-op** | No Wayland code path |
| `setAlwaysOnTop(true, level)` | Partial | Level string ignored; bool may have compositor-dependent effect |
| `setVisibleOnAllWorkspaces(true)` | Works | `visibleOnFullScreen` param is macOS-only, ignored on Linux |
| `setIgnoreMouseEvents(bool)` | **No-op** | No Wayland code path; use `hide()` instead |
| `globalShortcut.register()` | **Do not use** | Falls back to XGrabKey and disrupts XWayland input; use the GlobalShortcuts portal |

---

## EE2 overlay pattern on Wayland

EE2 separates the desktop session from the Electron window backend. Hotkeys,
active-window checks, and item acquisition use Wayland/Hyprland facilities,
while the transparent overlay uses XWayland alongside PoE2.

A regular Electron Wayland `xdg_toplevel` cannot provide the required
always-visible, click-through surface over a fullscreen XWayland game.
`setIgnoreMouseEvents()` and `showInactive()` are not supported by Electron's
native Wayland backend. EE2 therefore launches Electron with
`--ozone-platform=x11` and lets `electron-overlay-window` attach the overlay to
the PoE2 X11 window. The installed desktop entry and launcher include this flag
explicitly because `ELECTRON_OZONE_PLATFORM_HINT` is consumed before
application JavaScript runs.

On Hyprland, EE2 installs two temporary window rules before creating the
BrowserWindow. The passive title has `no_focus on`, keeping PoE2 focused while
the price-check UI remains rendered and click-through. Locked checks and the
full overlay switch to an interactive title with `no_focus off`, allowing the
window to receive input; EE2 then focuses the requested window with Hyprland's
`focuswindow` dispatcher. Returning to the game restores the passive title. No
manual Hyprland configuration is required.

Hotkeys still use the XDG GlobalShortcuts portal. `globalShortcut` is not
registered on a Wayland session because its XGrabKey fallback interferes with
PoE2 input. After portal registration, EE2 installs temporary non-consuming
Hyprland bindings with `hyprctl keyword bindn`. It replaces those bindings when
the configured shortcuts change and removes them during normal shutdown.

Portal actions run on key release so the physical trigger modifiers are no
longer held. Before an action runs, EE2 verifies the active window with
`hyprctl -j activewindow`. Item copying targets PoE2's XWayland window directly
with `xdotool`. A bundled Rust executable runs inside the game's Proton prefix
and reads the Windows clipboard because Proton's host clipboard bridge can
remain empty. The helper uses a bounded readiness/capture protocol and restores
the prior text in-process when clipboard restoration is enabled.

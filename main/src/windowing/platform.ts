import { app, type BrowserWindow } from "electron";
import { execFile, execFileSync } from "node:child_process";

const OVERLAY_TITLE = "Exiled Exchange 2";
const INTERACTIVE_OVERLAY_TITLE = `${OVERLAY_TITLE} [interactive]`;

export function isWaylandSession(): boolean {
  return (
    process.platform === "linux" &&
    (process.env.XDG_SESSION_TYPE === "wayland" ||
      Boolean(process.env.WAYLAND_DISPLAY))
  );
}

export function isNativeWayland(): boolean {
  return (
    isWaylandSession() &&
    app.commandLine.getSwitchValue("ozone-platform") !== "x11"
  );
}

export function prepareXWaylandOverlay(): boolean {
  if (!isWaylandSession() || !process.env.HYPRLAND_INSTANCE_SIGNATURE)
    return false;

  try {
    for (const rule of [
      `no_focus on, match:class ^(exiled-exchange-2)$, match:title ^${OVERLAY_TITLE}$`,
      `no_focus off, match:class ^(exiled-exchange-2)$, match:title ^${OVERLAY_TITLE} \\[interactive\\]$`,
    ]) {
      execFileSync("hyprctl", ["keyword", "windowrule", rule], {
        stdio: "ignore",
        timeout: 1_000,
      });
    }
    return true;
  } catch {
    // The native X11 helper still provides the overlay on other compositors.
    return false;
  }
}

export function setXWaylandOverlayFocusable(
  window: BrowserWindow | undefined,
  focusable: boolean,
): boolean {
  if (!window || isNativeWayland() || !process.env.HYPRLAND_INSTANCE_SIGNATURE)
    return false;

  window.setTitle(focusable ? INTERACTIVE_OVERLAY_TITLE : OVERLAY_TITLE);
  return true;
}

export function focusXWaylandOverlay(): void {
  if (isNativeWayland() || !process.env.HYPRLAND_INSTANCE_SIGNATURE) return;

  execFile(
    "hyprctl",
    ["dispatch", "focuswindow", "class:^(exiled-exchange-2)$"],
    () => {},
  );
}

export function focusXWaylandGame(): void {
  if (isNativeWayland() || !process.env.HYPRLAND_INSTANCE_SIGNATURE) return;

  execFile(
    "hyprctl",
    ["dispatch", "focuswindow", "class:^(steam_app_2694490)$"],
    () => {},
  );
}

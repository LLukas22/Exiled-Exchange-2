import { screen, globalShortcut } from "electron";
import {
  WaylandPortalShortcuts,
  type PortalShortcutEvent,
} from "./WaylandPortalShortcuts";
import { Hyprland } from "./Hyprland";
import { uIOhook, UiohookKey, UiohookWheelEvent } from "uiohook-napi";
import {
  isModKey,
  KeyToElectron,
  mergeTwoHotkeys,
} from "../../../ipc/KeyToCode";
import { typeInChat, stashSearch } from "./text-box";
import { WidgetAreaTracker } from "../windowing/WidgetAreaTracker";
import { HostClipboard } from "./HostClipboard";
import { OcrWorker } from "../vision/link-main";
import type { ShortcutAction } from "../../../ipc/types";
import type { Logger } from "../RemoteLogger";
import type { OverlayWindow } from "../windowing/OverlayWindow";
import type { GameWindow } from "../windowing/GameWindow";
import type { GameConfig } from "../host-files/GameConfig";
import type { ServerEvents } from "../server";

type UiohookKeyT = keyof typeof UiohookKey;
type CopyItemAction = Extract<ShortcutAction["action"], { type: "copy-item" }>;

const UiohookToName = Object.fromEntries(
  Object.entries(UiohookKey).map(([k, v]) => [v, k]),
);

export class Shortcuts {
  private actions: ShortcutAction[] = [];
  private stashScroll = false;
  private logKeys = false;
  private areaTracker: WidgetAreaTracker;
  private clipboard: HostClipboard;
  private portalHelper?: WaylandPortalShortcuts;
  private portalHotkeysKey: string | null = null;
  private portalSync = Promise.resolve();
  private hyprland = new Hyprland();
  private waylandCopyPending = false;

  static async create(
    logger: Logger,
    overlay: OverlayWindow,
    poeWindow: GameWindow,
    gameConfig: GameConfig,
    server: ServerEvents,
  ) {
    const ocrWorker = await OcrWorker.create();
    const shortcuts = new Shortcuts(
      logger,
      overlay,
      poeWindow,
      gameConfig,
      server,
      ocrWorker,
    );
    return shortcuts;
  }

  private constructor(
    private logger: Logger,
    private overlay: OverlayWindow,
    private poeWindow: GameWindow,
    private gameConfig: GameConfig,
    private server: ServerEvents,
    private ocrWorker: OcrWorker,
  ) {
    this.areaTracker = new WidgetAreaTracker(server, overlay);
    this.clipboard = new HostClipboard(logger);

    this.poeWindow.on("active-change", (isActive) => {
      process.nextTick(() => {
        if (isActive === this.poeWindow.isActive) {
          if (isActive) {
            this.register();
          } else {
            this.unregister();
          }
        }
      });
    });

    this.server.onEventAnyClient("CLIENT->MAIN::user-action", (e) => {
      if (e.action === "stash-search") {
        stashSearch(e.text, this.clipboard, this.overlay);
      }
    });

    uIOhook.on("keydown", (e) => {
      if (!this.logKeys) return;
      const pressed = eventToString(e);
      this.logger.write(`debug [Shortcuts] Keydown ${pressed}`);
    });
    uIOhook.on("keyup", (e) => {
      if (!this.logKeys) return;
      this.logger.write(
        `debug [Shortcuts] Keyup ${
          UiohookToName[e.keycode] || "not_supported_key"
        }`,
      );
    });

    uIOhook.on("wheel", (e) => {
      if (!e.ctrlKey || !this.poeWindow.isActive || !this.stashScroll) return;

      if (!isStashArea(e, this.poeWindow)) {
        if (e.rotation > 0) {
          uIOhook.keyTap(UiohookKey.ArrowRight);
        } else if (e.rotation < 0) {
          uIOhook.keyTap(UiohookKey.ArrowLeft);
        }
      }
    });
  }

  updateDelay(delay: number) {
    this.clipboard.updateDelay(delay);
  }

  async dispose() {
    this.portalHotkeysKey = null;
    await this.portalSync.catch(() => {});
    this.portalHelper?.stop();
    this.portalHelper = undefined;
    this.hyprland.stopInputHelper();
    try {
      await this.hyprland.clearGlobalBinds();
    } catch (error) {
      this.logger.write(
        `error [hyprland] failed to remove temporary binds: ${(error as Error).message}`,
      );
    }
  }

  updateActions(
    actions: ShortcutAction[],
    stashScroll: boolean,
    logKeys: boolean,
    restoreClipboard: boolean,
    language: string,
    windowTitle: string,
  ) {
    this.stashScroll = stashScroll;
    this.logKeys = logKeys;
    this.clipboard.updateOptions(restoreClipboard);
    this.ocrWorker.updateOptions(language);
    this.hyprland.updateWindowTitle(windowTitle);

    const copyItemShortcut = mergeTwoHotkeys(
      "Ctrl + C",
      this.gameConfig.showModsKey,
    );
    if (copyItemShortcut !== "Ctrl + C") {
      actions.push({
        shortcut: copyItemShortcut,
        action: { type: "test-only" },
      });
    }

    const allShortcuts = new Set([
      "Ctrl + C",
      "Ctrl + V",
      "Ctrl + A",
      "Ctrl + F",
      "Ctrl + Enter",
      "Home",
      "Delete",
      "Enter",
      "ArrowUp",
      "ArrowRight",
      "ArrowLeft",
      copyItemShortcut,
    ]);

    for (const action of actions) {
      if (
        allShortcuts.has(action.shortcut) &&
        action.action.type !== "test-only"
      ) {
        this.logger.write(
          `error [Shortcuts] Hotkey "${action.shortcut}" reserved by the game will not be registered.`,
        );
      }
    }
    actions = actions.filter((action) => !allShortcuts.has(action.shortcut));

    const duplicates = new Set<string>();
    for (const action of actions) {
      if (allShortcuts.has(action.shortcut)) {
        this.logger.write(
          `error [Shortcuts] It is not possible to use the same hotkey "${action.shortcut}" for multiple actions.`,
        );
        duplicates.add(action.shortcut);
      } else {
        allShortcuts.add(action.shortcut);
      }
    }
    this.actions = actions.filter(
      (action) =>
        !duplicates.has(action.shortcut) ||
        action.action.type === "toggle-overlay",
    );
    this.syncWaylandHotkeys();
    if (this.poeWindow.isActive) {
      this.unregister();
      this.register();
    }
  }

  private register() {
    // On Wayland, globalShortcut uses XGrabKey via XWayland and interferes with
    // PoE2's own input handling. The GlobalShortcuts portal is used instead.
    if (isWayland()) return;
    for (const entry of this.actions) {
      const isOk = globalShortcut.register(
        shortcutToElectron(entry.shortcut),
        () => {
          if (entry.keepModKeys) {
            const nonModKey = entry.shortcut
              .split(" + ")
              .filter((key) => !isModKey(key))[0];
            uIOhook.keyToggle(UiohookKey[nonModKey as UiohookKeyT], "up");
          } else {
            entry.shortcut
              .split(" + ")
              .reverse()
              .forEach((key) => {
                uIOhook.keyToggle(UiohookKey[key as UiohookKeyT], "up");
              });
          }
          this.runAction(entry);
        },
      );

      if (!isOk) {
        this.logger.write(
          `error [Shortcuts] Failed to register a shortcut "${entry.shortcut}". It is already registered by another application.`,
        );
      }

      if (entry.action.type === "test-only") {
        globalShortcut.unregister(shortcutToElectron(entry.shortcut));
      }
    }
  }

  private unregister() {
    if (isWayland()) return;
    globalShortcut.unregisterAll();
  }

  private syncWaylandHotkeys(actions = this.actions) {
    if (!isWayland()) return;

    const eligible = actions.filter((a) => a.action.type !== "test-only");
    const idCounts = new Map<string, number>();
    const registered = eligible.map((action) => {
      const baseId = portalActionId(action);
      const count = idCounts.get(baseId) ?? 0;
      idCounts.set(baseId, count + 1);
      return {
        action,
        hotkey: {
          id: count ? `${baseId}-${count + 1}` : baseId,
          accelerator: action.shortcut,
        },
      };
    });
    const hotkeys = registered.map(({ hotkey }) => hotkey);
    const hotkeysKey = JSON.stringify(hotkeys);
    if (hotkeysKey === this.portalHotkeysKey) return;

    this.portalHotkeysKey = hotkeysKey;
    const portalActions = new Map(
      registered.map(({ action, hotkey }) => [hotkey.id, action]),
    );
    this.portalSync = this.portalSync
      .catch(() => {})
      .then(async () => {
        if (hotkeysKey !== this.portalHotkeysKey) return;

        try {
          await this.hyprland.clearGlobalBinds();
        } catch (error) {
          if (hotkeysKey === this.portalHotkeysKey) {
            this.portalHotkeysKey = null;
          }
          this.logger.write(
            `error [hyprland] failed to remove temporary binds: ${(error as Error).message}`,
          );
          return;
        }
        this.portalHelper?.stop();
        this.portalHelper = undefined;
        if (!hotkeys.length) return;

        const portal = new WaylandPortalShortcuts();
        portal.on("event", (event) => {
          if (event.type === "error") {
            this.logger.write(`error [wayland-portal] ${event.message}`);
          } else if (event.type === "debug") {
            this.logger.write(`debug [wayland-portal] ${event.message}`);
          } else {
            this.handleWaylandHotkeyEvent(event, portalActions).catch(
              (error) => {
                this.logger.write(
                  `error [wayland-portal] ${(error as Error).message}`,
                );
              },
            );
          }
        });

        try {
          await portal.start(hotkeys);
        } catch (error) {
          await this.hyprland.clearGlobalBinds().catch(() => {});
          if (hotkeysKey === this.portalHotkeysKey) {
            this.portalHotkeysKey = null;
          }
          this.logger.write(
            `error [wayland-portal] GlobalShortcuts unavailable: ${(error as Error).message}`,
          );
          return;
        }
        if (hotkeysKey !== this.portalHotkeysKey) {
          portal.stop();
          return;
        }

        try {
          await this.hyprland.replaceGlobalBinds(hotkeys);
        } catch (error) {
          portal.stop();
          if (hotkeysKey === this.portalHotkeysKey) {
            this.portalHotkeysKey = null;
          }
          this.logger.write(
            `error [hyprland] failed to install temporary binds: ${(error as Error).message}`,
          );
          return;
        }
        if (hotkeysKey !== this.portalHotkeysKey) {
          await this.hyprland.clearGlobalBinds().catch(() => {});
          portal.stop();
          return;
        }

        this.portalHelper = portal;
        this.logger.write(
          `info [hyprland] installed ${hotkeys.length} temporary non-consuming binds`,
        );
      });
  }

  private async handleWaylandHotkeyEvent(
    event: PortalShortcutEvent,
    actions: Map<string, ShortcutAction>,
  ) {
    if (event.type !== "hotkey" || event.state !== "released") return;

    const entry = actions.get(event.id);
    if (!entry) return;
    if (this.logKeys) {
      this.logger.write(
        `debug [wayland-portal] Hotkey released ${event.accelerator}`,
      );
    }

    if (this.overlay.isInteractable) {
      if (entry.action.type === "toggle-overlay") this.runAction(entry);
      return;
    }
    if (await this.hyprland.isGameActive()) {
      this.runAction(entry);
    }
  }

  private runAction(entry: ShortcutAction) {
    if (this.logKeys) {
      this.logger.write(`debug [Shortcuts] Action type: ${entry.action.type}`);
    }
    if (entry.action.type === "toggle-overlay") {
      this.areaTracker.removeListeners();
      this.overlay.toggleActiveState();
    } else if (entry.action.type === "paste-in-chat") {
      typeInChat(entry.action.text, entry.action.send, this.clipboard);
    } else if (entry.action.type === "trigger-event") {
      this.server.sendEventTo("broadcast", {
        name: "MAIN->CLIENT::widget-action",
        payload: { target: entry.action.target },
      });
    } else if (entry.action.type === "stash-search") {
      stashSearch(entry.action.text, this.clipboard, this.overlay);
    } else if (entry.action.type === "copy-item") {
      const { action } = entry;
      const pressPosition = screen.getCursorScreenPoint();
      if (isWayland()) {
        this.handleWaylandCopyItem(action, pressPosition).catch((error) => {
          this.logger.write(
            `error [hyprland] copy failed: ${(error as Error).message}`,
          );
        });
      } else {
        this.clipboard
          .readItemText()
          .then((clipboard) => {
            this.emitItemText(action, clipboard, pressPosition);
          })
          .catch(() => {});
        pressKeysToCopyItemText(
          entry.keepModKeys
            ? entry.shortcut.split(" + ").filter((key) => isModKey(key))
            : undefined,
          this.gameConfig.showModsKey,
        );
      }
    } else if (
      entry.action.type === "ocr-text" &&
      entry.action.target === "heist-gems"
    ) {
      if (process.platform !== "win32") return;
      const { action } = entry;
      const pressTime = Date.now();
      const imageData = this.poeWindow.screenshot();
      this.ocrWorker
        .findHeistGems({
          width: this.poeWindow.bounds.width,
          height: this.poeWindow.bounds.height,
          data: imageData,
        })
        .then((result) => {
          this.server.sendEventTo("last-active", {
            name: "MAIN->CLIENT::ocr-text",
            payload: {
              target: action.target,
              pressTime,
              ocrTime: result.elapsed,
              paragraphs: result.recognized.map((p) => p.text),
            },
          });
        })
        .catch(() => {});
    }
  }

  private async handleWaylandCopyItem(
    action: CopyItemAction,
    pressPosition: { x: number; y: number },
  ) {
    if (this.waylandCopyPending) return;
    this.waylandCopyPending = true;
    try {
      const clipboard = await this.hyprland.copyItemText(
        mergeTwoHotkeys("Ctrl + C", this.gameConfig.showModsKey),
        this.clipboard.restoreEnabled,
      );
      this.emitItemText(action, clipboard, pressPosition);
    } finally {
      this.waylandCopyPending = false;
    }
  }

  private emitItemText(
    action: CopyItemAction,
    clipboard: string,
    pressPosition: { x: number; y: number },
  ) {
    this.areaTracker.removeListeners();
    this.server.sendEventTo("last-active", {
      name: "MAIN->CLIENT::item-text",
      payload: {
        target: action.target,
        clipboard,
        position: pressPosition,
        focusOverlay: Boolean(action.focusOverlay),
      },
    });
    if (action.focusOverlay && this.overlay.wasUsedRecently) {
      this.overlay.assertOverlayActive();
    }
  }
}

function portalActionId(entry: ShortcutAction) {
  const action = entry.action;
  if (action.type === "toggle-overlay") return "toggle-overlay";
  if (action.type === "copy-item") {
    return `copy-${slug(action.target)}${action.focusOverlay ? "-locked" : ""}`;
  }
  if (action.type === "trigger-event") return `event-${slug(action.target)}`;
  if (action.type === "ocr-text") return `ocr-${slug(action.target)}`;
  if (action.type === "stash-search") {
    return `stash-search-${shortHash(action.text)}`;
  }
  if (action.type === "paste-in-chat") {
    return `chat-command-${shortHash(`${action.text}:${action.send}`)}`;
  }
  return "test-only";
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function shortHash(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function isWayland(): boolean {
  return (
    process.platform === "linux" &&
    (process.env.XDG_SESSION_TYPE === "wayland" ||
      Boolean(process.env.WAYLAND_DISPLAY))
  );
}

function pressKeysToCopyItemText(
  pressedModKeys: string[] = [],
  showModsKey: string,
) {
  let keys = mergeTwoHotkeys("Ctrl + C", showModsKey).split(" + ");
  keys = keys.filter((key) => key !== "C");
  if (process.platform !== "darwin") {
    // On non-Mac platforms, don't toggle keys that are already being pressed.
    //
    // For unknown reasons, we need to toggle pressed keys on Mac for advanced
    // mod descriptions to be copied. You can test this by setting the shortcut
    // to "Alt + any letter". They'll work with this line, but not if it's
    // commented out.
    keys = keys.filter((key) => !pressedModKeys.includes(key));
  }

  for (const key of keys) {
    uIOhook.keyToggle(UiohookKey[key as UiohookKeyT], "down");
  }

  // finally press `C` to copy text
  uIOhook.keyTap(UiohookKey.C);

  // Timeout to enforce release of keys
  // Game was dropping the release inputs for some reason
  setTimeout(() => {
    keys.reverse();
    for (const key of keys) {
      uIOhook.keyToggle(UiohookKey[key as UiohookKeyT], "up");
    }
  }, 10);
}

function isStashArea(mouse: UiohookWheelEvent, poeWindow: GameWindow): boolean {
  if (
    !poeWindow.bounds ||
    mouse.x > poeWindow.bounds.x + poeWindow.uiSidebarWidth
  )
    return false;

  return (
    mouse.y > poeWindow.bounds.y + (poeWindow.bounds.height * 154) / 1600 &&
    mouse.y < poeWindow.bounds.y + (poeWindow.bounds.height * 1192) / 1600
  );
}

function eventToString(e: {
  keycode: number;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}) {
  const { ctrlKey, shiftKey, altKey } = e;

  let code = UiohookToName[e.keycode];
  if (!code) return "not_supported_key";

  if (code === "Shift" || code === "Alt" || code === "Ctrl") return code;

  if (ctrlKey && shiftKey && altKey) code = `Ctrl + Shift + Alt + ${code}`;
  else if (shiftKey && altKey) code = `Shift + Alt + ${code}`;
  else if (ctrlKey && shiftKey) code = `Ctrl + Shift + ${code}`;
  else if (ctrlKey && altKey) code = `Ctrl + Alt + ${code}`;
  else if (altKey) code = `Alt + ${code}`;
  else if (ctrlKey) code = `Ctrl + ${code}`;
  else if (shiftKey) code = `Shift + ${code}`;

  return code;
}

function shortcutToElectron(shortcut: string) {
  return shortcut
    .split(" + ")
    .map((k) => KeyToElectron[k as keyof typeof KeyToElectron])
    .join("+");
}

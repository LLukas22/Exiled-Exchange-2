import { EventEmitter } from "node:events";
import dbus, { type MessageBus } from "dbus-next";

const { Variant } = dbus;

const PORTAL_BUS = "org.freedesktop.portal.Desktop";
const PORTAL_PATH = "/org/freedesktop/portal/desktop";
const GLOBAL_SHORTCUTS_IFACE = "org.freedesktop.portal.GlobalShortcuts";
const REGISTRY_IFACE = "org.freedesktop.host.portal.Registry";
const REQUEST_IFACE = "org.freedesktop.portal.Request";
const DBUS_BUS = "org.freedesktop.DBus";
const DBUS_PATH = "/org/freedesktop/DBus";
const DBUS_IFACE = "org.freedesktop.DBus";
const PORTAL_APP_ID = "exiled-exchange-2";

export interface PortalHotkey {
  id: string;
  accelerator: string;
}

export type PortalShortcutEvent =
  | { type: "ready"; hotkeys: number }
  | { type: "debug"; message: string }
  | {
      type: "hotkey";
      id: string;
      accelerator: string;
      timestamp: number;
      state: "pressed" | "released";
    }
  | { type: "error"; code: string; message: string }
  | { type: "exit" };

interface RequestResponse {
  response: number;
  results: Record<string, { signature: string; value: unknown }>;
}

export class WaylandPortalShortcuts extends EventEmitter {
  private bus?: MessageBus;
  private sessionHandle?: string;
  private hotkeys = new Map<string, PortalHotkey>();
  private signalMatch?: string;

  async start(hotkeys: PortalHotkey[]): Promise<void> {
    if (this.bus) {
      throw new Error("Wayland portal shortcuts are already running");
    }
    if (!hotkeys.length) return;

    const bus = dbus.sessionBus();
    this.bus = bus;

    try {
      await registerPortalAppId(bus);
      this.emit("event", {
        type: "debug",
        message: `registered portal app id ${PORTAL_APP_ID}`,
      } satisfies PortalShortcutEvent);
      const portal = await getPortalInterface(bus);
      await assertPortalVersion(portal);
      this.sessionHandle = await this.createSession(bus, portal);
      const boundIds = await this.bindShortcuts(portal, hotkeys);

      if (!boundIds.size) {
        throw new Error("portal did not bind any shortcuts");
      }

      this.hotkeys = new Map(
        hotkeys
          .filter((hotkey) => boundIds.has(hotkey.id))
          .map((hotkey) => [hotkey.id, hotkey]),
      );
      await this.installSignalHandler(bus);
      this.emit("event", {
        type: "ready",
        hotkeys: this.hotkeys.size,
      } satisfies PortalShortcutEvent);
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  async setHotkeys(hotkeys: PortalHotkey[]): Promise<void> {
    this.stop();
    await this.start(hotkeys);
  }

  stop() {
    if (this.bus && this.signalMatch) {
      removeMatch(this.bus, this.signalMatch).catch(() => {});
    }
    this.bus?.disconnect();
    this.bus = undefined;
    this.sessionHandle = undefined;
    this.hotkeys.clear();
    this.signalMatch = undefined;
    this.emit("event", { type: "exit" } satisfies PortalShortcutEvent);
  }

  override on(event: "event", cb: (event: PortalShortcutEvent) => void): this {
    return super.on(event, cb);
  }

  private async createSession(bus: MessageBus, portal: PortalInterface) {
    const responseToken = token("ee2_create");
    const sessionToken = token("ee2_session");
    const pendingResponse = await prepareRequestResponse(bus, responseToken);
    const returnedHandle = await portal.CreateSession({
      handle_token: new Variant("s", responseToken),
      session_handle_token: new Variant("s", sessionToken),
    });
    this.emit("event", {
      type: "debug",
      message: `CreateSession request ${pendingResponse.requestHandle}, returned ${returnedHandle}`,
    } satisfies PortalShortcutEvent);
    const response = await pendingResponse.response;
    if (response.response !== 0) {
      throw new Error(
        `portal CreateSession failed with response ${response.response}`,
      );
    }
    const sessionHandle = response.results.session_handle?.value;
    if (typeof sessionHandle !== "string") {
      throw new Error(
        "portal CreateSession response did not include session_handle",
      );
    }
    return sessionHandle;
  }

  private async bindShortcuts(
    portal: PortalInterface,
    hotkeys: PortalHotkey[],
  ) {
    if (!this.bus || !this.sessionHandle) {
      throw new Error("portal session was not created");
    }

    const responseToken = token("ee2_bind");
    const pendingResponse = await prepareRequestResponse(
      this.bus,
      responseToken,
    );
    const returnedHandle = await portal.BindShortcuts(
      this.sessionHandle,
      hotkeys.map((hotkey) => [hotkey.id, shortcutOptions(hotkey)]),
      "",
      { handle_token: new Variant("s", responseToken) },
    );
    this.emit("event", {
      type: "debug",
      message: `BindShortcuts request ${pendingResponse.requestHandle}, returned ${returnedHandle}`,
    } satisfies PortalShortcutEvent);
    const response = await pendingResponse.response;
    if (response.response !== 0) {
      throw new Error(
        `portal BindShortcuts failed with response ${response.response}`,
      );
    }

    const bound = response.results.shortcuts?.value;
    if (!Array.isArray(bound)) {
      return new Set(hotkeys.map((hotkey) => hotkey.id));
    }
    return new Set(
      bound
        .map((entry) => (Array.isArray(entry) ? entry[0] : undefined))
        .filter((id): id is string => typeof id === "string"),
    );
  }

  private async installSignalHandler(bus: MessageBus) {
    const match = `type='signal',interface='${GLOBAL_SHORTCUTS_IFACE}'`;
    await addMatch(bus, match);
    this.signalMatch = match;
    bus.on("message", (msg) => {
      if (
        msg.interface !== GLOBAL_SHORTCUTS_IFACE ||
        (msg.member !== "Activated" && msg.member !== "Deactivated") ||
        !Array.isArray(msg.body)
      ) {
        return;
      }

      const [sessionHandle, shortcutId, timestamp] = msg.body;
      this.emit("event", {
        type: "debug",
        message: `${msg.member} signal session=${String(sessionHandle)} shortcut=${String(shortcutId)}`,
      } satisfies PortalShortcutEvent);
      if (
        sessionHandle !== this.sessionHandle ||
        typeof shortcutId !== "string"
      ) {
        return;
      }
      const hotkey = this.hotkeys.get(shortcutId);
      if (!hotkey) return;

      this.emit("event", {
        type: "hotkey",
        id: hotkey.id,
        accelerator: hotkey.accelerator,
        timestamp: Number(timestamp),
        state: msg.member === "Activated" ? "pressed" : "released",
      } satisfies PortalShortcutEvent);
    });
  }
}

interface PortalInterface {
  CreateSession: (
    options: Record<string, InstanceType<typeof Variant>>,
  ) => Promise<string>;
  BindShortcuts: (
    sessionHandle: string,
    shortcuts: Array<[string, Record<string, InstanceType<typeof Variant>>]>,
    parentWindow: string,
    options: Record<string, InstanceType<typeof Variant>>,
  ) => Promise<string>;
}

interface RegistryInterface {
  Register: (
    appId: string,
    options: Record<string, InstanceType<typeof Variant>>,
  ) => Promise<void>;
}

async function registerPortalAppId(bus: MessageBus): Promise<void> {
  const object = await bus.getProxyObject(PORTAL_BUS, PORTAL_PATH);
  const registry = object.getInterface(
    REGISTRY_IFACE,
  ) as unknown as RegistryInterface;
  await registry.Register(PORTAL_APP_ID, {});
}

async function getPortalInterface(bus: MessageBus): Promise<PortalInterface> {
  const object = await bus.getProxyObject(PORTAL_BUS, PORTAL_PATH);
  return object.getInterface(
    GLOBAL_SHORTCUTS_IFACE,
  ) as unknown as PortalInterface;
}

async function assertPortalVersion(portal: PortalInterface) {
  const version = (portal as unknown as { version?: unknown }).version;
  if (typeof version === "number" && version < 1) {
    throw new Error(`unsupported GlobalShortcuts portal version ${version}`);
  }
}

function shortcutOptions(hotkey: PortalHotkey) {
  const options: Record<string, InstanceType<typeof Variant>> = {
    description: new Variant("s", `Exiled Exchange 2: ${hotkey.id}`),
  };
  const preferredTrigger = portalTrigger(hotkey.accelerator);
  if (preferredTrigger) {
    options.preferred_trigger = new Variant("s", preferredTrigger);
  }
  return options;
}

function portalTrigger(accelerator: string): string | undefined {
  const parts = accelerator.split(" + ").map((part) => part.trim());
  const out: string[] = [];
  for (const part of parts) {
    if (part === "Ctrl") out.push("CTRL");
    else if (part === "Alt") out.push("ALT");
    else if (part === "Shift") out.push("SHIFT");
    else if (part === "Meta" || part === "Super") out.push("LOGO");
    else {
      const key = portalKey(part);
      if (!key) return undefined;
      out.push(key);
    }
  }
  return out.join("+");
}

function portalKey(key: string): string | undefined {
  if (/^[A-Z]$/.test(key)) return key.toLowerCase();
  if (/^[0-9]$/.test(key)) return key;
  if (/^F([1-9]|1[0-2])$/.test(key)) return key;

  const map: Record<string, string> = {
    Space: "space",
    Tab: "Tab",
    Home: "Home",
    End: "End",
    PageUp: "Page_Up",
    PageDown: "Page_Down",
    Insert: "Insert",
    Delete: "Delete",
    Escape: "Escape",
    Enter: "Return",
    Backspace: "BackSpace",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
  };
  return map[key];
}

async function prepareRequestResponse(
  bus: MessageBus,
  handleToken: string,
): Promise<{ requestHandle: string; response: Promise<RequestResponse> }> {
  const requestHandle = requestPath(bus, handleToken);
  const match = `type='signal',interface='${REQUEST_IFACE}',member='Response',path='${requestHandle}'`;
  await addMatch(bus, match);

  const response = new Promise<RequestResponse>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(`timed out waiting for portal response ${requestHandle}`),
      );
    }, 30_000);

    const handler = (msg: {
      path?: string;
      interface?: string;
      member?: string;
      body?: unknown[];
    }) => {
      if (
        msg.path !== requestHandle ||
        msg.interface !== REQUEST_IFACE ||
        msg.member !== "Response"
      ) {
        return;
      }
      cleanup();
      const [response, results] = msg.body ?? [];
      resolve({
        response: Number(response),
        results: (results ?? {}) as RequestResponse["results"],
      });
    };

    const cleanup = () => {
      clearTimeout(timeout);
      bus.off("message", handler);
      removeMatch(bus, match).catch(() => {});
    };

    bus.on("message", handler);
  });
  return { requestHandle, response };
}

function requestPath(bus: MessageBus, handleToken: string) {
  const uniqueName = (bus as MessageBus & { name?: string | null }).name;
  if (!uniqueName) {
    throw new Error("D-Bus session bus did not assign a unique name");
  }
  const sender = uniqueName.replace(/^:/, "").replace(/\./g, "_");
  return `/org/freedesktop/portal/desktop/request/${sender}/${handleToken}`;
}

async function addMatch(bus: MessageBus, match: string) {
  const dbusIface = await getDbusInterface(bus);
  await dbusIface.AddMatch(match);
}

async function removeMatch(bus: MessageBus, match: string) {
  const dbusIface = await getDbusInterface(bus);
  await dbusIface.RemoveMatch(match);
}

async function getDbusInterface(bus: MessageBus) {
  const object = await bus.getProxyObject(DBUS_BUS, DBUS_PATH);
  return object.getInterface(DBUS_IFACE) as unknown as {
    AddMatch: (match: string) => Promise<void>;
    RemoveMatch: (match: string) => Promise<void>;
  };
}

function token(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.trunc(Math.random() * 1_000_000)}`;
}

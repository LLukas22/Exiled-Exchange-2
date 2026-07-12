import { EventEmitter } from "node:events";
import dbus, { type MessageBus } from "dbus-next";

const { Variant } = dbus;

const PORTAL_BUS = "org.freedesktop.portal.Desktop";
const PORTAL_PATH = "/org/freedesktop/portal/desktop";
const GLOBAL_SHORTCUTS_IFACE = "org.freedesktop.portal.GlobalShortcuts";
const REQUEST_IFACE = "org.freedesktop.portal.Request";
const DBUS_BUS = "org.freedesktop.DBus";
const DBUS_PATH = "/org/freedesktop/DBus";
const DBUS_IFACE = "org.freedesktop.DBus";

export type PortalHotkey = {
  id: string;
  accelerator: string;
};

export type PortalShortcutEvent =
  | { type: "ready"; hotkeys: number }
  | { type: "hotkey"; id: string; accelerator: string; timestamp: number }
  | { type: "error"; code: string; message: string }
  | { type: "exit" };

type RequestResponse = {
  response: number;
  results: Record<string, { signature: string; value: unknown }>;
};

export class WaylandPortalShortcuts extends EventEmitter {
  private bus?: MessageBus;
  private sessionHandle?: string;
  private hotkeys = new Map<string, PortalHotkey>();
  private activationMatch?: string;

  async start(hotkeys: PortalHotkey[]): Promise<void> {
    if (this.bus) {
      throw new Error("Wayland portal shortcuts are already running");
    }
    if (!hotkeys.length) return;

    const bus = dbus.sessionBus();
    this.bus = bus;

    try {
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
      await this.installActivationHandler(bus);
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
    if (this.bus && this.activationMatch) {
      removeMatch(this.bus, this.activationMatch).catch(() => {});
    }
    this.bus?.disconnect();
    this.bus = undefined;
    this.sessionHandle = undefined;
    this.hotkeys.clear();
    this.activationMatch = undefined;
    this.emit("event", { type: "exit" } satisfies PortalShortcutEvent);
  }

  override on(event: "event", cb: (event: PortalShortcutEvent) => void): this {
    return super.on(event, cb);
  }

  private async createSession(bus: MessageBus, portal: PortalInterface) {
    const responseToken = token("ee2_create");
    const sessionToken = token("ee2_session");
    const requestHandle = (await portal.CreateSession({
      handle_token: new Variant("s", responseToken),
      session_handle_token: new Variant("s", sessionToken),
    })) as string;
    const response = await waitRequestResponse(bus, requestHandle);
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

    const requestHandle = (await portal.BindShortcuts(
      this.sessionHandle,
      hotkeys.map((hotkey) => [hotkey.id, shortcutOptions(hotkey)]),
      "",
      { handle_token: new Variant("s", token("ee2_bind")) },
    )) as string;
    const response = await waitRequestResponse(this.bus, requestHandle);
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

  private async installActivationHandler(bus: MessageBus) {
    const match = `type='signal',interface='${GLOBAL_SHORTCUTS_IFACE}',member='Activated'`;
    await addMatch(bus, match);
    this.activationMatch = match;
    bus.on("message", (msg) => {
      if (
        msg.interface !== GLOBAL_SHORTCUTS_IFACE ||
        msg.member !== "Activated" ||
        !Array.isArray(msg.body)
      ) {
        return;
      }

      const [sessionHandle, shortcutId, timestamp] = msg.body;
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
      } satisfies PortalShortcutEvent);
    });
  }
}

type PortalInterface = {
  CreateSession(
    options: Record<string, InstanceType<typeof Variant>>,
  ): Promise<string>;
  BindShortcuts(
    sessionHandle: string,
    shortcuts: Array<[string, Record<string, InstanceType<typeof Variant>>]>,
    parentWindow: string,
    options: Record<string, InstanceType<typeof Variant>>,
  ): Promise<string>;
};

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

async function waitRequestResponse(
  bus: MessageBus,
  requestHandle: string,
): Promise<RequestResponse> {
  const match = `type='signal',interface='${REQUEST_IFACE}',member='Response',path='${requestHandle}'`;
  await addMatch(bus, match);

  return await new Promise((resolve, reject) => {
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
    AddMatch(match: string): Promise<void>;
    RemoveMatch(match: string): Promise<void>;
  };
}

function token(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.trunc(Math.random() * 1_000_000)}`;
}

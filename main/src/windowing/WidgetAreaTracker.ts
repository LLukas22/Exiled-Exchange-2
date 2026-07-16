import { Rectangle, Point, screen } from "electron";
import { uIOhook, UiohookMouseEvent } from "uiohook-napi";
import type { OverlayWindow } from "./OverlayWindow";
import type { ServerEvents } from "../server";
import { isWaylandSession } from "./platform";

export class WidgetAreaTracker {
  private holdKey!: string;
  private from!: Point;
  private area!: Rectangle;
  private closeThreshold!: number;
  private isHoldKeyLatched = false;
  constructor(
    private server: ServerEvents,
    private overlay: OverlayWindow,
  ) {
    this.server.onEventAnyClient("OVERLAY->MAIN::track-area", (opts) => {
      this.holdKey = opts.holdKey;

      if (process.platform === "win32") {
        this.closeThreshold = opts.closeThreshold * opts.dpr;
        this.from = screen.dipToScreenPoint(opts.from);
        // NOTE: bug in electron accepting only integers
        this.area = screen.dipToScreenRect(null, roundRect(opts.area));
      } else if (process.platform === "linux") {
        this.closeThreshold = opts.closeThreshold * opts.dpr;

        const display = screen.getDisplayNearestPoint(opts.from);
        const scaleX = (value: number) =>
          scaleNumberByDisplay(
            value,
            display.bounds.x,
            display.nativeOrigin.x,
            display.scaleFactor,
          );
        const scaleY = (value: number) =>
          scaleNumberByDisplay(
            value,
            display.bounds.y,
            display.nativeOrigin.y,
            display.scaleFactor,
          );

        // scale coordinates using the display scale factor.
        this.from = {
          x: scaleX(opts.from.x),
          y: scaleY(opts.from.y),
        };

        this.area = roundRect({
          x: scaleX(opts.area.x),
          y: scaleY(opts.area.y),
          width: opts.area.width * display.scaleFactor,
          height: opts.area.height * display.scaleFactor,
        });
      } else {
        this.closeThreshold = opts.closeThreshold;
        this.from = opts.from;
        this.area = opts.area;
      }

      this.removeListeners();
      this.isHoldKeyLatched = isWaylandSession();
      uIOhook.addListener("mousemove", this.handleMouseMove);
      uIOhook.addListener("mousedown", this.handleMouseDown);
    });
  }

  removeListeners() {
    uIOhook.removeListener("mousemove", this.handleMouseMove);
    uIOhook.removeListener("mousedown", this.handleMouseDown);
    this.isHoldKeyLatched = false;
  }

  private readonly handleMouseMove = (e: UiohookMouseEvent) => {
    const modifier = e.ctrlKey ? "Ctrl" : e.altKey ? "Alt" : undefined;
    if (
      !this.overlay.isInteractable &&
      !this.isHoldKeyLatched &&
      modifier !== this.holdKey
    ) {
      const distance = Math.hypot(e.x - this.from.x, e.y - this.from.y);
      if (distance > this.closeThreshold) {
        this.server.sendEventTo("broadcast", {
          name: "MAIN->OVERLAY::hide-exclusive-widget",
          payload: undefined,
        });
        this.removeListeners();
      }
    } else if (isPointInsideRect(e, this.area)) {
      this.isHoldKeyLatched = false;
      this.overlay.assertOverlayActive();
    } else if (this.overlay.isInteractable) {
      this.removeListeners();
      this.overlay.assertGameActive();
    }
  };

  private readonly handleMouseDown = (e: UiohookMouseEvent) => {
    if (isPointInsideRect(e, this.area)) {
      this.removeListeners();
      this.overlay.assertOverlayActive();
    } else if (!this.overlay.isInteractable && this.isHoldKeyLatched) {
      this.server.sendEventTo("broadcast", {
        name: "MAIN->OVERLAY::hide-exclusive-widget",
        payload: undefined,
      });
      this.removeListeners();
    }
  };
}

function isPointInsideRect(point: Point, rect: Rectangle) {
  return (
    point.x > rect.x &&
    point.x < rect.x + rect.width &&
    point.y > rect.y &&
    point.y < rect.y + rect.height
  );
}

function roundRect(rect: Rectangle) {
  // NOTE: bug in electron accepting only integers
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}
function scaleNumberByDisplay(
  value: number,
  boundValue: number,
  nativeValue: number,
  scaleFactor: number,
) {
  return (value - boundValue + nativeValue) * scaleFactor;
}

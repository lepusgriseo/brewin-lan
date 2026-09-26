// Pan and zoom arithmetic for the topology stage. Pure — no Obsidian, no DOM — so the awkward
// cases (a one-device diagram, a pane with no width yet, a pinch that must keep the point between
// your fingers still) are settled here and tested, instead of being debugged through a phone.

import { Bounds } from "./topology";

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 3;
/** Fitting never magnifies past this: a two-device network filling the screen looks broken. */
export const FIT_MAX_ZOOM = 1.2;

export interface Viewport {
  /** Stage-space offset applied before the scale. */
  pan: { x: number; y: number };
  zoom: number;
}

export interface Size {
  width: number;
  height: number;
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** The world coordinate currently under a point on the stage. */
export function screenToWorld(view: Viewport, x: number, y: number): { x: number; y: number } {
  return { x: (x - view.pan.x) / view.zoom, y: (y - view.pan.y) / view.zoom };
}

/**
 * Zooms to `nextZoom` while keeping whatever is under (`anchorX`, `anchorY`) exactly there.
 *
 * That anchor is the whole trick of a gesture feeling right: under the cursor for a wheel, and
 * between the fingers for a pinch. Zooming about the centre instead makes the thing you were
 * looking at slide away as you zoom in.
 */
export function zoomTo(view: Viewport, nextZoom: number, anchorX: number, anchorY: number): Viewport {
  const zoom = clampZoom(nextZoom);
  const ratio = zoom / view.zoom;
  return {
    zoom,
    pan: {
      x: anchorX - (anchorX - view.pan.x) * ratio,
      y: anchorY - (anchorY - view.pan.y) * ratio,
    },
  };
}

export interface FitOptions {
  /** Stage pixels left clear around the diagram. */
  padding?: number;
  maxZoom?: number;
}

/**
 * The viewport that shows all of `bounds` inside `size`, centred.
 *
 * Returns null when there is nothing to fit or the stage has not been laid out yet — which on a
 * phone is the normal state for the first frame or two, so the caller waits and asks again rather
 * than fitting to a zero-sized box.
 */
export function fitView(bounds: Bounds, size: Size, opts: FitOptions = {}): Viewport | null {
  if (size.width <= 0 || size.height <= 0) return null;
  const padding = opts.padding ?? 80;
  const maxZoom = opts.maxZoom ?? FIT_MAX_ZOOM;

  // A single device has zero extent in both directions; treat it as one pixel so the arithmetic
  // stays finite and the node ends up centred rather than in the corner.
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  // Never let the padding eat the whole pane: on a narrow phone it easily exceeds the width.
  const usableW = Math.max(size.width * 0.5, size.width - padding);
  const usableH = Math.max(size.height * 0.5, size.height - padding);

  const zoom = Math.min(maxZoom, clampZoom(Math.min(usableW / width, usableH / height)));
  return {
    zoom,
    pan: {
      x: size.width / 2 - ((bounds.minX + bounds.maxX) / 2) * zoom,
      y: size.height / 2 - ((bounds.minY + bounds.maxY) / 2) * zoom,
    },
  };
}

/** One step of the zoom buttons and the keyboard, about the middle of the stage. */
export function zoomStep(view: Viewport, direction: 1 | -1, size: Size): Viewport {
  const factor = direction > 0 ? 1.25 : 1 / 1.25;
  return zoomTo(view, view.zoom * factor, size.width / 2, size.height / 2);
}

export interface PinchStart {
  /** Distance between the two fingers when the gesture began. */
  distance: number;
  zoom: number;
  /** The world point that was under the midpoint of the fingers when the gesture began. */
  anchor: { x: number; y: number };
}

export function pointerDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function midpoint(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number } {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Remembers what the fingers grabbed. `mid` is in stage coordinates. */
export function beginPinch(view: Viewport, distance: number, mid: { x: number; y: number }): PinchStart {
  return { distance, zoom: view.zoom, anchor: screenToWorld(view, mid.x, mid.y) };
}

/**
 * The viewport for one frame of a pinch: **the piece of the diagram the fingers grabbed stays
 * between them**, however far they spread or where the hand moves.
 *
 * Stating it that way — rather than as a zoom step plus a pan step — is what makes it exact. Every
 * frame is computed from the gesture's start, so nothing accumulates, a pinch and a drag happen
 * together for free, and hitting the zoom limit still tracks the hand instead of sticking.
 *
 * Returns null for a degenerate gesture (a zero distance, which a flat two-finger tap can report)
 * so the caller leaves the view alone rather than dividing by it.
 */
export function pinchMove(start: PinchStart, current: { distance: number; mid: { x: number; y: number } }): Viewport | null {
  if (!(start.distance > 0) || !(current.distance > 0)) return null;
  const zoom = clampZoom(start.zoom * (current.distance / start.distance));
  return {
    zoom,
    pan: { x: current.mid.x - start.anchor.x * zoom, y: current.mid.y - start.anchor.y * zoom },
  };
}

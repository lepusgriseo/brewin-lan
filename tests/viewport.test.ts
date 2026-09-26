import { test } from "node:test";
import assert from "node:assert/strict";

import {
  beginPinch,
  clampZoom,
  fitView,
  FIT_MAX_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  midpoint,
  pinchMove,
  pointerDistance,
  screenToWorld,
  Viewport,
  zoomStep,
  zoomTo,
} from "../src/viewport";
import { Bounds } from "../src/topology";

const STAGE = { width: 800, height: 600 };
const PHONE = { width: 390, height: 500 };
const view = (zoom: number, x = 0, y = 0): Viewport => ({ zoom, pan: { x, y } });
const bounds = (minX: number, minY: number, maxX: number, maxY: number): Bounds => ({ minX, minY, maxX, maxY });

test("zoom is clamped, and nonsense falls back to 1", () => {
  assert.equal(clampZoom(1), 1);
  assert.equal(clampZoom(99), MAX_ZOOM);
  assert.equal(clampZoom(0.01), MIN_ZOOM);
  assert.equal(clampZoom(Number.NaN), 1);
  assert.equal(clampZoom(Number.POSITIVE_INFINITY), 1);
});

test("zooming keeps whatever is under the anchor exactly there", () => {
  const before = view(1, 20, -35);
  const anchor = { x: 300, y: 220 };
  const world = screenToWorld(before, anchor.x, anchor.y);
  const after = zoomTo(before, 2.4, anchor.x, anchor.y);
  const moved = screenToWorld(after, anchor.x, anchor.y);
  assert.ok(Math.abs(moved.x - world.x) < 1e-9, `${moved.x} vs ${world.x}`);
  assert.ok(Math.abs(moved.y - world.y) < 1e-9);
});

test("a zoom beyond the limit still keeps the anchor still", () => {
  const anchor = { x: 120, y: 90 };
  const before = view(1);
  const world = screenToWorld(before, anchor.x, anchor.y);
  const after = zoomTo(before, 1000, anchor.x, anchor.y);
  assert.equal(after.zoom, MAX_ZOOM);
  const moved = screenToWorld(after, anchor.x, anchor.y);
  assert.ok(Math.abs(moved.x - world.x) < 1e-9);
});

test("the zoom buttons work about the middle of the stage", () => {
  const centre = { x: STAGE.width / 2, y: STAGE.height / 2 };
  const before = view(1, 10, 10);
  const world = screenToWorld(before, centre.x, centre.y);
  const inAgain = zoomStep(before, 1, STAGE);
  assert.ok(inAgain.zoom > 1);
  const moved = screenToWorld(inAgain, centre.x, centre.y);
  assert.ok(Math.abs(moved.x - world.x) < 1e-9);
  // Out then in returns to where it started.
  const roundTrip = zoomStep(zoomStep(before, 1, STAGE), -1, STAGE);
  assert.ok(Math.abs(roundTrip.zoom - before.zoom) < 1e-9);
  assert.ok(Math.abs(roundTrip.pan.x - before.pan.x) < 1e-9);
});

test("fitting centres the diagram in the stage", () => {
  const fitted = fitView(bounds(0, 0, 400, 300), STAGE)!;
  const centreX = fitted.pan.x + 200 * fitted.zoom;
  const centreY = fitted.pan.y + 150 * fitted.zoom;
  assert.ok(Math.abs(centreX - STAGE.width / 2) < 1e-9);
  assert.ok(Math.abs(centreY - STAGE.height / 2) < 1e-9);
});

test("a big diagram is scaled down to fit, a small one is not blown up", () => {
  const big = fitView(bounds(0, 0, 4000, 3000), STAGE)!;
  assert.ok(big.zoom < 1);
  assert.ok(4000 * big.zoom <= STAGE.width);
  const small = fitView(bounds(0, 0, 50, 40), STAGE)!;
  assert.equal(small.zoom, FIT_MAX_ZOOM);
});

test("a single device is centred rather than parked in the corner", () => {
  const one = fitView(bounds(0, 0, 0, 0), PHONE)!;
  assert.ok(Number.isFinite(one.zoom) && one.zoom > 0);
  assert.equal(one.pan.x, PHONE.width / 2);
  assert.equal(one.pan.y, PHONE.height / 2);
});

test("a stage with no size yet cannot be fitted to — the caller must wait", () => {
  // The normal state of a phone's first paint, and fitting to it would strand the diagram.
  assert.equal(fitView(bounds(0, 0, 400, 300), { width: 0, height: 0 }), null);
  assert.equal(fitView(bounds(0, 0, 400, 300), { width: 390, height: 0 }), null);
});

test("padding never eats a narrow pane", () => {
  // 80px of padding out of 390 is fine; 500 would be absurd, and must not invert the scale.
  const fitted = fitView(bounds(0, 0, 1000, 800), PHONE, { padding: 500 })!;
  assert.ok(fitted.zoom > 0);
  assert.ok(fitted.zoom >= Math.min(PHONE.width * 0.5 / 1000, PHONE.height * 0.5 / 800) - 1e-9);
});

test("a pinch keeps what the fingers grabbed between them", () => {
  const before = view(1);
  const a = { x: 100, y: 100 };
  const b = { x: 200, y: 100 };
  assert.equal(pointerDistance(a, b), 100);
  assert.deepEqual(midpoint(a, b), { x: 150, y: 100 });
  const start = beginPinch(before, pointerDistance(a, b), midpoint(a, b));
  // At zoom 1 with no pan, the world point grabbed is the midpoint itself.
  assert.deepEqual(start.anchor, { x: 150, y: 100 });

  // Fingers spread to twice the distance, hand still: 2× zoom, grabbed point unmoved.
  const spread = pinchMove(start, { distance: 200, mid: { x: 150, y: 100 } })!;
  assert.ok(Math.abs(spread.zoom - 2) < 1e-9);
  assert.deepEqual(screenToWorld(spread, 150, 100), start.anchor);

  // Same spread, but the hand also slid 40px right and 10 down: the grabbed point comes with it.
  const slid = pinchMove(start, { distance: 200, mid: { x: 190, y: 110 } })!;
  assert.equal(slid.zoom, spread.zoom);
  assert.deepEqual(screenToWorld(slid, 190, 110), start.anchor);

  // Two fingers that only move, without spreading, are a pan.
  const dragged = pinchMove(start, { distance: 100, mid: { x: 250, y: 100 } })!;
  assert.equal(dragged.zoom, 1);
  assert.deepEqual(screenToWorld(dragged, 250, 100), start.anchor);
});

test("a pinch on an already panned and zoomed view grabs the right piece", () => {
  const before = view(0.5, -120, 40);
  const mid = { x: 300, y: 200 };
  const start = beginPinch(before, 80, mid);
  assert.deepEqual(start.anchor, screenToWorld(before, mid.x, mid.y));
  const after = pinchMove(start, { distance: 160, mid: { x: 260, y: 240 } })!;
  assert.ok(Math.abs(after.zoom - 1) < 1e-9);
  assert.deepEqual(screenToWorld(after, 260, 240), start.anchor);
});

test("pinching past the limit still tracks the hand instead of sticking", () => {
  const start = beginPinch(view(1), 100, { x: 150, y: 100 });
  const far = pinchMove(start, { distance: 100_000, mid: { x: 300, y: 250 } })!;
  assert.equal(far.zoom, MAX_ZOOM);
  assert.deepEqual(screenToWorld(far, 300, 250), start.anchor);
});

test("every frame is computed from the gesture's start, so nothing drifts", () => {
  const start = beginPinch(view(1), 100, { x: 150, y: 100 });
  let last = pinchMove(start, { distance: 101, mid: { x: 150, y: 100 } })!;
  for (let d = 102; d <= 150; d++) last = pinchMove(start, { distance: d, mid: { x: 150, y: 100 } })!;
  const single = pinchMove(start, { distance: 150, mid: { x: 150, y: 100 } })!;
  assert.deepEqual(last, single);
});

test("a degenerate pinch is refused rather than producing NaN", () => {
  const start = beginPinch(view(1), 0, { x: 10, y: 10 });
  assert.equal(pinchMove(start, { distance: 50, mid: { x: 0, y: 0 } }), null);
  assert.equal(pinchMove(beginPinch(view(1), 50, { x: 10, y: 10 }), { distance: 0, mid: { x: 0, y: 0 } }), null);
});

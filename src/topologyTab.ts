import { setIcon } from "obsidian";
import { findType, typeIcon, typeLabel } from "./deviceTypes";
import { segmentKey, segmentLabel } from "./network";
import { buildTopology, INTERNET_ID, LayoutMode, TopoNode, Topology } from "./topology";
import { ViewContext } from "./viewContext";
import { beginPinch, fitView, midpoint, pinchMove, PinchStart, pointerDistance, Viewport, zoomStep, zoomTo } from "./viewport";
import { Device } from "./types";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Kept by the view so panning, zoom and selection survive a re-render from a vault change. */
export interface TopoState {
  mode: LayoutMode;
  pan: { x: number; y: number };
  zoom: number;
  selected: string | null;
  /** Segment key to highlight; everything else dims. */
  highlight: string | null;
  /** Set once the first fit has happened, so a later refresh doesn't yank the view back. */
  fitted: boolean;
}

export function renderTopology(root: HTMLElement, ctx: ViewContext, state: TopoState): void {
  const topo = buildTopology(ctx.net, {
    mode: state.mode,
    nodeSpacing: ctx.settings.nodeSpacing,
    levelSpacing: ctx.settings.levelSpacing,
    showInternet: ctx.settings.showInternet,
    types: ctx.settings.deviceTypes,
    includeRetired: ctx.settings.includeRetired,
  });

  const wrap = root.createDiv({ cls: "brewin-lan-topo-wrap" });
  const stage = wrap.createDiv({ cls: "brewin-lan-stage" });
  stage.tabIndex = 0;
  const world = stage.createDiv({ cls: "brewin-lan-world" });

  if (topo.nodes.length === 0) {
    stage.createDiv({
      cls: "brewin-lan-empty",
      text: "No devices yet. Press ＋ Device to add the router, then hang things off it.",
    });
  }

  // One SVG behind the nodes for the links. It is a 1×1 box with overflow visible, so the lines can
  // be drawn straight in world coordinates without the SVG needing to know how big the diagram is.
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.addClass("brewin-lan-edges");
  world.appendChild(svg);

  const byId = new Map(topo.nodes.map((n) => [n.id, n]));
  const dimmed = (node: TopoNode): boolean =>
    state.highlight !== null && !(node.segment !== null && segmentKey(node.segment) === state.highlight);

  // ── Bands, in VLAN mode: drawn first so they sit behind everything ──────────
  for (const band of topo.bands) {
    const xs = topo.nodes.filter((n) => n.y === band.y).map((n) => n.x);
    if (xs.length === 0) continue;
    const label = world.createDiv({ cls: "brewin-lan-band-label", text: band.label });
    label.style.left = `${Math.min(...xs) - ctx.settings.nodeSpacing * 0.8}px`;
    label.style.top = `${band.y}px`;
    if (band.segment) label.style.setProperty("--band-colour", ctx.colourOf(band.segment));
    const rule = world.createDiv({ cls: "brewin-lan-band-rule" });
    rule.style.left = `${Math.min(...xs) - ctx.settings.nodeSpacing * 0.5}px`;
    rule.style.top = `${band.y}px`;
    rule.style.width = `${Math.max(...xs) - Math.min(...xs) + ctx.settings.nodeSpacing}px`;
  }

  // ── Links ──────────────────────────────────────────────────────────────────
  for (const edge of topo.edges) {
    const a = byId.get(edge.from);
    const b = byId.get(edge.to);
    if (!a || !b) continue;
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", String(a.x));
    line.setAttribute("y1", String(a.y));
    line.setAttribute("x2", String(b.x));
    line.setAttribute("y2", String(b.y));
    line.addClass("brewin-lan-edge");
    if (edge.trunk) line.addClass("is-trunk");
    if (edge.cycle) line.addClass("is-cycle");
    if (dimmed(a) && dimmed(b)) line.addClass("is-dimmed");
    // The link takes the colour of the segment at the far end, which is what makes a VLAN's reach
    // visible along the spine.
    if (b.segment) line.style.stroke = ctx.colourOf(b.segment);
    svg.appendChild(line);

    if (edge.port !== null || edge.toPort !== null) {
      // Both ends when both are known — `24⇄1` reads "their port 24, our port 1".
      const label = edge.port !== null && edge.toPort !== null ? `${edge.port}⇄${edge.toPort}` : String(edge.port ?? edge.toPort);
      const tag = world.createDiv({ cls: "brewin-lan-port-tag", text: label });
      // Two-thirds of the way along, so a switch with eight children doesn't stack its labels.
      tag.style.left = `${a.x + (b.x - a.x) * 0.72}px`;
      tag.style.top = `${a.y + (b.y - a.y) * 0.72}px`;
      if (edge.trunk) tag.addClass("is-trunk");
      const ends = [
        edge.port !== null ? `port ${edge.port} on ${a.title}` : null,
        edge.toPort !== null ? `port ${edge.toPort} on ${b.title}` : null,
      ].filter(Boolean);
      tag.setAttr("aria-label", `${ends.join(" ⇄ ")}${edge.trunk ? " (trunk)" : ""}`);
      tag.setAttr("title", `${ends.join("\n⇄ ")}${edge.trunk ? "\ntrunk" : ""}`);
    }
  }

  // ── Devices ────────────────────────────────────────────────────────────────
  for (const node of topo.nodes) {
    const el = world.createDiv({ cls: "brewin-lan-node" });
    el.style.left = `${node.x}px`;
    el.style.top = `${node.y}px`;
    el.dataset.id = node.id;
    if (node.id === state.selected) el.addClass("is-selected");
    if (dimmed(node)) el.addClass("is-dimmed");
    if (node.detached) el.addClass("is-detached");
    if (node.status === "planned") el.addClass("is-planned");
    if (node.status === "offline" || node.status === "retired") el.addClass("is-down");

    const badge = el.createDiv({ cls: "brewin-lan-node-icon" });
    badge.style.setProperty("--node-colour", ctx.colourOf(node.segment));
    setIcon(badge, node.id === INTERNET_ID ? "cloud" : typeIcon(node.type, ctx.settings.deviceTypes));

    const problems = node.device ? ctx.issuesFor(node.device.path) : [];
    const worst = problems.some((p) => p.severity === "error") ? "error" : problems.some((p) => p.severity === "warn") ? "warn" : null;
    if (worst) badge.createSpan({ cls: `brewin-lan-node-flag is-${worst}`, text: "!" });

    const label = el.createDiv({ cls: "brewin-lan-node-label" });
    label.createDiv({ cls: "brewin-lan-node-title", text: node.title });
    if (node.ip) label.createDiv({ cls: "brewin-lan-node-ip", text: node.ip });

    const detail = [typeLabel(node.type, ctx.settings.deviceTypes), node.ip ?? "no address", node.segment ? segmentLabel(node.segment) : "no segment"];
    el.setAttr("aria-label", `${node.title} — ${detail.join(" · ")}`);
    el.setAttr("title", `${node.title}\n${detail.join("\n")}`);

    if (node.device) {
      el.tabIndex = 0;
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        state.selected = node.id;
        ctx.refresh();
      });
      el.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        ctx.open(node.id);
      });
      el.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") {
          e.preventDefault();
          ctx.open(node.id);
        }
      });
    }
  }

  stage.addEventListener("click", () => {
    if (state.selected !== null) {
      state.selected = null;
      ctx.refresh();
    }
  });

  const { fit } = bindPanZoom(stage, world, state, topo, () => updateZoomReadout(stage, state));
  renderZoomControls(stage, world, state, fit);
  renderLegend(wrap, ctx, state);

  const selected = state.selected === null ? null : ctx.net.byPath.get(state.selected) ?? null;
  if (selected) renderProfile(wrap, ctx, selected);
}

function applyTransform(world: HTMLElement, state: TopoState): void {
  world.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
}

function viewOf(state: TopoState): Viewport {
  return { pan: { ...state.pan }, zoom: state.zoom };
}

function store(state: TopoState, view: Viewport, world: HTMLElement, onChange: () => void): void {
  state.pan = view.pan;
  state.zoom = view.zoom;
  applyTransform(world, state);
  onChange();
}

/**
 * Pan, zoom and pinch on the stage.
 *
 * Touch needs three things desktop does not: `touch-action: none`, or the browser claims the
 * gesture as a page scroll and the pointer events stop arriving mid-drag; a two-pointer pinch,
 * since there is no wheel; and a size to fit to, which on a phone is not known for the first frame
 * or two — hence the ResizeObserver rather than a single timeout.
 */
function bindPanZoom(stage: HTMLElement, world: HTMLElement, state: TopoState, topo: Topology, onChange: () => void): { fit: () => void } {
  // Set in code as well as CSS: this one property is the difference between pinch working and the
  // gestures being swallowed, so it should not depend on the stylesheet having loaded.
  stage.style.touchAction = "none";

  const sizeOf = (): { width: number; height: number } => {
    const rect = stage.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  };

  const fit = (): boolean => {
    if (topo.nodes.length === 0) return true;
    const view = fitView(topo.bounds, sizeOf());
    if (!view) return false;
    store(state, view, world, onChange);
    return true;
  };

  if (state.fitted) {
    applyTransform(world, state);
  } else {
    // Fit as soon as the stage has a size. On mobile the first paint reports zero width, and a
    // fit against that would leave the diagram parked in the corner.
    const observer = new ResizeObserver(() => {
      if (state.fitted) {
        observer.disconnect();
        return;
      }
      if (fit()) {
        state.fitted = true;
        observer.disconnect();
      }
    });
    observer.observe(stage);
    if (fit()) {
      state.fitted = true;
      observer.disconnect();
    }
    // Belt and braces: never leave an observer watching a pane that never gets a size.
    window.setTimeout(() => observer.disconnect(), 10_000);
  }

  stage.addEventListener("dblclick", (e) => {
    if ((e.target as HTMLElement).closest(".brewin-lan-node")) return;
    fit();
  });

  // ── Pointers: one to pan, two to pinch ───────────────────────────────────
  //
  // A drag may start anywhere, including on a device — on a phone that is most of the canvas, and
  // a thumb landing on an icon should still move the diagram. What separates a drag from a tap is
  // distance: past a few pixels the gesture becomes a pan and the click it would have produced is
  // swallowed, so nothing gets selected by accident.
  //
  // The pointer is captured only once that threshold is crossed. Capturing on pointerdown would
  // make every click land on the stage instead of the device that was tapped.
  const DRAG_THRESHOLD = 6;
  const pointers = new Map<number, { x: number; y: number }>();
  let last = { x: 0, y: 0 };
  let travelled = 0;
  let dragging = false;
  let suppressClick = false;
  let pinch: PinchStart | null = null;

  const positions = (): { x: number; y: number }[] => [...pointers.values()];
  const localMid = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    // Midpoints are measured inside the stage, since that is the box the transform is relative to.
    const rect = stage.getBoundingClientRect();
    const mid = midpoint(a, b);
    return { x: mid.x - rect.left, y: mid.y - rect.top };
  };

  stage.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest(".brewin-lan-zoom")) return;
    // A mouse's right or middle button should not start a drag; a touch always reports button 0.
    if (e.pointerType === "mouse" && e.button !== 0) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    suppressClick = false;
    travelled = 0;
    dragging = false;

    if (pointers.size === 2) {
      const [a, b] = positions();
      pinch = beginPinch(viewOf(state), pointerDistance(a, b), localMid(a, b));
      // A pinch is never a tap, whatever it started on.
      suppressClick = true;
      return;
    }
    last = { x: e.clientX, y: e.clientY };
  });

  stage.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size >= 2) {
      if (!pinch) return;
      const [a, b] = positions();
      const next = pinchMove(pinch, { distance: pointerDistance(a, b), mid: localMid(a, b) });
      if (next) store(state, next, world, onChange);
      return;
    }

    if (pointers.size !== 1) return;
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    travelled += Math.hypot(dx, dy);
    last = { x: e.clientX, y: e.clientY };
    state.pan.x += dx;
    state.pan.y += dy;
    applyTransform(world, state);

    if (!dragging && travelled > DRAG_THRESHOLD) {
      dragging = true;
      suppressClick = true;
      // Now that it is definitely a drag, follow the finger even when it leaves the stage.
      try {
        stage.setPointerCapture(e.pointerId);
      } catch {
        /* the pointer may already be gone */
      }
    }
  });

  const release = (e: PointerEvent): void => {
    pointers.delete(e.pointerId);
    // Lifting one finger ends the pinch rather than handing back to a pan mid-gesture; the
    // remaining finger starts a fresh drag from wherever it is now, which is what it looks like.
    pinch = null;
    dragging = false;
    const [only] = positions();
    if (only) last = { ...only };
  };
  stage.addEventListener("pointerup", release);
  stage.addEventListener("pointercancel", release);
  stage.addEventListener("lostpointercapture", release);

  // Runs before the device's own handler and before the stage's deselect, so a pan never doubles
  // as a selection.
  stage.addEventListener(
    "click",
    (e) => {
      if (!suppressClick) return;
      suppressClick = false;
      e.stopPropagation();
      e.preventDefault();
    },
    true
  );

  // Obsidian's mobile shell reads horizontal swipes as "open the sidebar", which it would do
  // while the diagram is being panned. Keeping touch gestures that start on the stage to the
  // stage is the only way to have both.
  for (const type of ["touchstart", "touchmove"] as const) {
    stage.addEventListener(type, (e) => e.stopPropagation(), { passive: true });
  }

  stage.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const rect = stage.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      store(state, zoomTo(viewOf(state), state.zoom * factor, e.clientX - rect.left, e.clientY - rect.top), world, onChange);
    },
    { passive: false }
  );

  stage.addEventListener("keydown", (e) => {
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      store(state, zoomStep(viewOf(state), 1, sizeOf()), world, onChange);
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      store(state, zoomStep(viewOf(state), -1, sizeOf()), world, onChange);
    } else if (e.key === "0") {
      e.preventDefault();
      fit();
    }
  });

  return { fit: () => void fit() };
}

/**
 * The zoom controls.
 *
 * Buttons rather than gestures alone: a pinch is fiddly on a small screen with one hand, a
 * trackpad's pinch is not always delivered as a wheel event, and "fit" is otherwise a double-tap
 * nobody would guess. They sit over the stage, thumb-sized on mobile.
 */
function renderZoomControls(stage: HTMLElement, world: HTMLElement, state: TopoState, fit: () => void): void {
  const box = stage.createDiv({ cls: "brewin-lan-zoom" });
  const level = () => `${Math.round(state.zoom * 100)}%`;
  let readout: HTMLElement | null = null;
  const update = (): void => readout?.setText(level());

  const button = (label: string, icon: string, onClick: () => void): void => {
    const el = box.createEl("button", { cls: "brewin-lan-zoom-btn" });
    setIcon(el, icon);
    el.setAttr("aria-label", label);
    el.setAttr("title", label);
    // Pointer events on the stage would otherwise read a tap on the button as the start of a pan.
    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
      update();
    });
  };

  const sizeOf = () => {
    const rect = stage.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  };

  button("Zoom in", "plus", () => store(state, zoomStep(viewOf(state), 1, sizeOf()), world, update));
  readout = box.createDiv({ cls: "brewin-lan-zoom-level", text: level() });
  button("Zoom out", "minus", () => store(state, zoomStep(viewOf(state), -1, sizeOf()), world, update));
  button("Fit the whole network", "maximize", () => {
    fit();
    update();
  });
}

function renderLegend(wrap: HTMLElement, ctx: ViewContext, state: TopoState): void {
  const legend = wrap.createDiv({ cls: "brewin-lan-legend" });
  for (const segment of ctx.net.segments) {
    const key = segmentKey(segment);
    const count = ctx.net.placements.filter((p) => p.segment !== null && segmentKey(p.segment) === key).length;
    const chip = legend.createDiv({ cls: "brewin-lan-legend-chip" + (state.highlight === key ? " is-on" : "") });
    chip.createSpan({ cls: "brewin-lan-swatch" }).style.background = ctx.colourOf(segment);
    chip.createSpan({ text: segmentLabel(segment) });
    chip.createSpan({ cls: "brewin-lan-legend-count", text: String(count) });
    chip.setAttr("role", "button");
    chip.setAttr("aria-label", `Highlight ${segmentLabel(segment)}`);
    chip.addEventListener("click", () => {
      state.highlight = state.highlight === key ? null : key;
      ctx.refresh();
    });
  }
  if (ctx.net.segments.length === 0) {
    legend.createSpan({ cls: "brewin-lan-legend-empty", text: "No VLANs or subnets defined yet — press ＋ VLAN." });
  }
}

/** The device profile: everything the notes know, in one panel, with the fixes one click away. */
function renderProfile(wrap: HTMLElement, ctx: ViewContext, device: Device): void {
  const panel = wrap.createDiv({ cls: "brewin-lan-profile" });
  const head = panel.createDiv({ cls: "brewin-lan-profile-head" });
  const icon = head.createDiv({ cls: "brewin-lan-profile-icon" });
  setIcon(icon, typeIcon(device.type, ctx.settings.deviceTypes));
  const heading = head.createDiv();
  const titleRow = heading.createDiv({ cls: "brewin-lan-profile-title" });
  titleRow.createSpan({ text: device.title });
  titleRow.createSpan({ cls: `brewin-lan-status is-${device.status}`, text: device.status });
  heading.createDiv({
    cls: "brewin-lan-profile-sub",
    text: [
      typeLabel(device.type, ctx.settings.deviceTypes),
      device.managed === null ? null : device.managed ? "managed" : "unmanaged",
      device.hostname,
      device.location,
    ]
      .filter(Boolean)
      .join(" · "),
  });
  head.createEl("button", { cls: "brewin-lan-icon-btn", text: "↗" }).addEventListener("click", () => ctx.open(device.path));

  // Interfaces
  const table = panel.createEl("table", { cls: "brewin-lan-table brewin-lan-iface-table" });
  const header = table.createEl("thead").createEl("tr");
  ["Interface", "Address", "Segment", "How", "MAC"].forEach((h) => header.createEl("th", { text: h }));
  const body = table.createEl("tbody");
  if (device.ifaces.length === 0) body.createEl("tr").createEl("td", { attr: { colspan: "5" }, text: "No addresses recorded." });
  for (const iface of device.ifaces) {
    const placement = ctx.net.placements.find((p) => p.device.path === device.path && p.iface === iface);
    const row = body.createEl("tr");
    row.createEl("td", { text: iface.name });
    row.createEl("td", { text: iface.ip === null ? "—" : iface.prefix === null ? iface.ip : `${iface.ip}/${iface.prefix}` });
    const segCell = row.createEl("td");
    if (placement?.segment) {
      segCell.createSpan({ cls: "brewin-lan-swatch" }).style.background = ctx.colourOf(placement.segment);
      segCell.createSpan({ text: segmentLabel(placement.segment) });
    } else {
      segCell.createSpan({ cls: "brewin-lan-muted", text: "none" });
    }
    row.createEl("td", { text: iface.assign === "unknown" ? "—" : iface.assign });
    row.createEl("td", { text: iface.mac ?? "—" });
    if (iface.note) {
      const noteRow = body.createEl("tr", { cls: "brewin-lan-iface-note" });
      noteRow.createEl("td", { attr: { colspan: "5" }, text: iface.note });
    }
  }

  // Where it plugs in, and what plugs into it
  const links = panel.createDiv({ cls: "brewin-lan-profile-links" });
  const parent = ctx.net.devices.find((d) => d.title.toLowerCase() === (device.uplink ?? "").toLowerCase());
  const uplinkRow = links.createDiv({ cls: "brewin-lan-kv" });
  uplinkRow.createSpan({ cls: "brewin-lan-k", text: "Uplink" });
  if (parent) {
    const link = uplinkRow.createSpan({ cls: "brewin-lan-link", text: parent.title });
    link.addEventListener("click", () => ctx.focus(parent.path));
    // Named rather than abbreviated here, because this is the one place with room to be plain
    // about which end is which.
    const ends = [
      device.uplinkPort !== null ? `port ${device.uplinkPort} on ${parent.title}` : null,
      device.localPort !== null ? `port ${device.localPort} here` : null,
    ].filter(Boolean);
    if (ends.length) uplinkRow.createSpan({ cls: "brewin-lan-muted", text: ` · ${ends.join(" ⇄ ")}` });
  } else {
    uplinkRow.createSpan({ cls: "brewin-lan-muted", text: device.uplink ? `${device.uplink} — no such device` : "none" });
  }

  if (findType(device.type, ctx.settings.deviceTypes).hosts) renderPortMap(panel, ctx, device);

  if (device.services.length) {
    const row = links.createDiv({ cls: "brewin-lan-kv" });
    row.createSpan({ cls: "brewin-lan-k", text: "Services" });
    row.createSpan({ text: device.services.join(" · ") });
  }
  if (device.notes) {
    const row = links.createDiv({ cls: "brewin-lan-kv" });
    row.createSpan({ cls: "brewin-lan-k", text: "Purpose" });
    row.createSpan({ text: device.notes });
  }

  const problems = ctx.issuesFor(device.path);
  if (problems.length) {
    const box = panel.createDiv({ cls: "brewin-lan-profile-issues" });
    for (const issue of problems) {
      const row = box.createDiv({ cls: "brewin-lan-issue" });
      row.createSpan({ cls: `brewin-lan-dot is-${issue.severity}` });
      row.createSpan({ text: issue.message });
    }
  }
}

/** A switch's ports, occupancy derived from who says they plug into them. */
function renderPortMap(panel: HTMLElement, ctx: ViewContext, device: Device): void {
  const count = device.ports;
  const box = panel.createDiv({ cls: "brewin-lan-ports" });
  box.createDiv({ cls: "brewin-lan-ports-head", text: count === null ? "Ports (count not recorded)" : `Ports — ${count}` });
  const children = ctx.net.devices.filter((d) => (d.uplink ?? "").toLowerCase() === device.title.toLowerCase());
  // Both ends of every link that touches this device: what plugs in, and the port it uses to plug
  // into something else. The second is the half that used to be invisible — a switch's own uplink
  // port looked free, and the address map would happily offer it to a laptop.
  const claimed = new Map<number, { title: string; path: string; uplink: boolean }[]>();
  const claim = (port: number, entry: { title: string; path: string; uplink: boolean }): void =>
    void claimed.set(port, [...(claimed.get(port) ?? []), entry]);
  for (const child of children) {
    if (child.uplinkPort === null) continue;
    claim(child.uplinkPort, { title: child.title, path: child.path, uplink: false });
  }
  if (device.localPort !== null && device.uplink) {
    const parent = ctx.net.devices.find((d) => d.title.toLowerCase() === (device.uplink ?? "").toLowerCase());
    claim(device.localPort, { title: `↑ ${device.uplink}`, path: parent?.path ?? device.path, uplink: true });
  }

  const grid = box.createDiv({ cls: "brewin-lan-port-grid" });
  const highest = Math.max(count ?? 0, ...[...claimed.keys()], 0);
  for (let port = 1; port <= highest; port++) {
    const config = device.portConfig.find((p) => p.port === port);
    const on = claimed.get(port) ?? [];
    const cell = grid.createDiv({ cls: "brewin-lan-port" });
    if (on.length > 1) cell.addClass("is-conflict");
    else if (on.length === 1) cell.addClass("is-used");
    if (config?.mode === "trunk") cell.addClass("is-trunk");
    if (device.poePorts.includes(port)) cell.addClass("is-poe");
    if (count !== null && port > count) cell.addClass("is-phantom");
    if (on.some((o) => o.uplink)) cell.addClass("is-uplink");
    cell.createSpan({ cls: "brewin-lan-port-no", text: String(port) });
    cell.createSpan({ cls: "brewin-lan-port-name", text: on.map((d) => d.title).join(" + ") || (config?.label ?? "") });
    const bits = [
      config?.mode === "trunk" ? `trunk, native ${config.vlan ?? "?"}${config.allowed.length ? `, allowed ${config.allowed.join("/")}` : ""}` : config?.vlan ? `access VLAN ${config.vlan}` : null,
      device.poePorts.includes(port) ? "PoE" : null,
      count !== null && port > count ? "beyond the port count" : null,
    ].filter(Boolean);
    cell.setAttr("title", `Port ${port}${on.length ? ` — ${on.map((d) => d.title).join(", ")}` : " — free"}${bits.length ? `\n${bits.join("\n")}` : ""}`);
    if (on.length === 1) cell.addEventListener("click", () => ctx.focus(on[0].path));
  }
  if (highest === 0) box.createDiv({ cls: "brewin-lan-muted", text: "Nothing recorded as plugged in, and no port count set." });
}

/** Keeps the readout honest when the zoom changes by gesture rather than by button. */
function updateZoomReadout(stage: HTMLElement, state: TopoState): void {
  const readout = stage.querySelector(".brewin-lan-zoom-level");
  if (readout) readout.textContent = `${Math.round(state.zoom * 100)}%`;
}

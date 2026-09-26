import { Notice } from "obsidian";
import { addressMap, AddressCell } from "./addressMap";
import { DeviceModal } from "./deviceModal";
import { formatRange, intToIp } from "./ip";
import { nextFreeIn, segmentKey, segmentLabel, unplaced } from "./network";
import { SegmentModal } from "./segmentModal";
import { ViewContext } from "./viewContext";
import { Segment } from "./types";

export interface AddressState {
  /** Segment key being shown; null means the first one. */
  segment: string | null;
}

/** The address space, segment by segment: what is used, what is pooled, and what is actually free. */
export function renderAddresses(root: HTMLElement, ctx: ViewContext, state: AddressState): void {
  if (ctx.net.segments.length === 0) {
    const empty = root.createDiv({ cls: "brewin-lan-empty" });
    empty.createDiv({ text: "No VLANs or subnets defined yet." });
    empty
      .createEl("button", { text: "＋ Define one", cls: "mod-cta" })
      .addEventListener("click", () => new SegmentModal(ctx.app, ctx.store, ctx.refresh).open());
    return;
  }

  const chips = root.createDiv({ cls: "brewin-lan-segbar" });
  const current = ctx.net.segments.find((s) => segmentKey(s) === state.segment) ?? ctx.net.segments[0];
  for (const segment of ctx.net.segments) {
    const key = segmentKey(segment);
    const chip = chips.createDiv({ cls: "brewin-lan-segtab" + (key === segmentKey(current) ? " is-on" : "") });
    chip.createSpan({ cls: "brewin-lan-swatch" }).style.background = ctx.colourOf(segment);
    chip.createSpan({ text: segmentLabel(segment) });
    chip.addEventListener("click", () => {
      state.segment = key;
      ctx.refresh();
    });
  }

  const map = addressMap(ctx.net, current, { maxCells: ctx.settings.maxGridCells });
  const { stats } = map;

  const header = root.createDiv({ cls: "brewin-lan-seghead" });
  const title = header.createDiv({ cls: "brewin-lan-seghead-title" });
  const titleLink = title.createSpan({ cls: current.path ? "brewin-lan-link" : "", text: segmentLabel(current) });
  if (current.path) titleLink.addEventListener("click", () => ctx.open(current.path as string));
  title.createSpan({ cls: "brewin-lan-mono brewin-lan-muted", text: current.cidrText || "no CIDR" });

  const facts = header.createDiv({ cls: "brewin-lan-facts" });
  const fact = (label: string, value: string): void => {
    const box = facts.createDiv({ cls: "brewin-lan-fact" });
    box.createDiv({ cls: "brewin-lan-fact-value", text: value });
    box.createDiv({ cls: "brewin-lan-fact-label", text: label });
  };
  fact("usable", String(stats.usable));
  fact("documented", String(stats.used));
  fact("in the pool", String(stats.pool));
  fact("reserved", String(stats.reserved));
  fact("free for static", String(stats.freeStatic));
  fact("used", `${Math.round(stats.utilisation * 100)}%`);

  const meta = root.createDiv({ cls: "brewin-lan-segmeta" });
  const metaRow = (label: string, value: string): void => {
    const row = meta.createDiv({ cls: "brewin-lan-kv" });
    row.createSpan({ cls: "brewin-lan-k", text: label });
    row.createSpan({ cls: "brewin-lan-mono", text: value });
  };
  if (current.gateway) metaRow("Gateway", current.gateway);
  if (current.pool) metaRow("DHCP pool", formatRange(current.pool));
  if (current.reserved.length) metaRow("Reserved", current.reserved.map(formatRange).join(", "));
  const free = nextFreeIn(ctx.net, current);
  metaRow("Next free static", free ?? "none left");
  if (current.purpose) {
    const row = meta.createDiv({ cls: "brewin-lan-kv" });
    row.createSpan({ cls: "brewin-lan-k", text: "Purpose" });
    row.createSpan({ text: current.purpose });
  }

  // ── The grid ───────────────────────────────────────────────────────────────
  if (map.truncated) {
    root.createDiv({
      cls: "brewin-lan-note",
      text: `${current.cidrText} holds ${stats.usable.toLocaleString()} addresses — too many to draw. The documented ones are listed below.`,
    });
    const list = root.createEl("table", { cls: "brewin-lan-table" });
    const head = list.createEl("thead").createEl("tr");
    ["Address", "Device", "Interface", "How"].forEach((h) => head.createEl("th", { text: h }));
    const body = list.createEl("tbody");
    for (const p of ctx.net.placements.filter((p) => p.segment !== null && segmentKey(p.segment) === segmentKey(current) && p.ipInt !== null)) {
      const row = body.createEl("tr");
      row.createEl("td", { cls: "brewin-lan-mono", text: p.iface.ip as string });
      const cell = row.createEl("td");
      cell.createSpan({ cls: "brewin-lan-link", text: p.device.title }).addEventListener("click", () => ctx.open(p.device.path));
      row.createEl("td", { text: p.iface.name });
      row.createEl("td", { text: p.iface.assign === "unknown" ? "—" : p.iface.assign });
    }
  } else {
    const grid = root.createDiv({ cls: "brewin-lan-grid" });
    for (const cell of map.cells) drawCell(grid, ctx, current, cell);
    const key = root.createDiv({ cls: "brewin-lan-gridkey" });
    const legend: [string, string][] = [
      ["device", "documented"],
      ["gateway", "gateway"],
      ["pool", "DHCP pool"],
      ["reserved", "reserved"],
      ["free", "free"],
      ["network", "network / broadcast"],
    ];
    for (const [cls, label] of legend) {
      const chip = key.createDiv({ cls: "brewin-lan-gridkey-item" });
      chip.createSpan({ cls: `brewin-lan-cell is-${cls}` });
      chip.createSpan({ text: label });
    }
  }

  // Addresses no segment explains — shown here because this is the tab where they would be missed.
  const strays = unplaced(ctx.net);
  if (strays.length) {
    const box = root.createDiv({ cls: "brewin-lan-strays" });
    box.createDiv({ cls: "brewin-lan-strays-head", text: `${strays.length} address${strays.length === 1 ? "" : "es"} in no known segment` });
    for (const p of strays) {
      const row = box.createDiv({ cls: "brewin-lan-kv" });
      row.createSpan({ cls: "brewin-lan-mono brewin-lan-k", text: p.iface.ip as string });
      row.createSpan({ cls: "brewin-lan-link", text: `${p.device.title} (${p.iface.name})` }).addEventListener("click", () => ctx.open(p.device.path));
    }
    box.createEl("button", { text: "＋ Define the missing subnet" }).addEventListener("click", () => new SegmentModal(ctx.app, ctx.store, ctx.refresh).open());
  }
}

function drawCell(grid: HTMLElement, ctx: ViewContext, segment: Segment, cell: AddressCell): void {
  const el = grid.createDiv({ cls: `brewin-lan-cell is-${cell.state}` });
  const last = cell.ip.split(".")[3];
  el.createSpan({ text: last });
  if (cell.state === "device" || cell.state === "gateway") el.style.setProperty("--cell-colour", ctx.colourOf(segment));
  if (cell.inPool && cell.state === "device") el.addClass("is-inpool");

  const who = cell.placement ? `${cell.placement.device.title} (${cell.placement.iface.name})` : null;
  const bits = [cell.ip, who, cell.state === "gateway" && !who ? "gateway, undocumented" : null, cell.inPool ? "in the DHCP pool" : null, cell.reserved ? "reserved" : null]
    .filter(Boolean)
    .join(" · ");
  el.setAttr("title", bits);
  el.setAttr("aria-label", bits);

  if (cell.placement) {
    el.addEventListener("click", () => ctx.focus((cell.placement as { device: { path: string } }).device.path));
    return;
  }
  if (cell.state === "network" || cell.state === "broadcast") return;
  // A free cell is the fastest route to "put something here".
  el.addClass("is-clickable");
  el.addEventListener("click", () => {
    if (cell.reserved || cell.inPool) {
      new Notice(`${cell.ip} is ${cell.reserved ? "reserved" : "inside the DHCP pool"} — creating a device on it anyway.`);
    }
    new DeviceModal(ctx.app, ctx.store, ctx.net, ctx.settings.deviceTypes, ctx.refresh, null, { ip: cell.ip, segment }).open();
  });
}

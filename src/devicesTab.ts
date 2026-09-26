import { setIcon } from "obsidian";
import { typeIcon, typeLabel } from "./deviceTypes";
import { compareIps } from "./ip";
import { linkPorts, segmentKey, segmentLabel } from "./network";
import { ViewContext } from "./viewContext";
import { Device } from "./types";

export interface DeviceFilters {
  search: string;
  type: string;
  segment: string;
  status: string;
  sort: "name" | "ip" | "type" | "status";
}

export const DEFAULT_FILTERS: DeviceFilters = { search: "", type: "", segment: "", status: "", sort: "ip" };

/** The inventory: every device, filterable, with the things worth scanning for in columns. */
export function renderDevices(root: HTMLElement, ctx: ViewContext, filters: DeviceFilters): void {
  const bar = root.createDiv({ cls: "brewin-lan-filterbar" });

  const search = bar.createEl("input", { type: "search", cls: "brewin-lan-search", placeholder: "Search name, address, MAC…" });
  search.value = filters.search;

  const typeSelect = bar.createEl("select");
  typeSelect.createEl("option", { value: "", text: "Any type" });
  for (const type of ctx.settings.deviceTypes) {
    if (!ctx.net.devices.some((d) => d.type === type.id)) continue;
    typeSelect.createEl("option", { value: type.id, text: type.label });
  }
  typeSelect.value = filters.type;

  const segSelect = bar.createEl("select");
  segSelect.createEl("option", { value: "", text: "Any segment" });
  ctx.net.segments.forEach((s) => segSelect.createEl("option", { value: segmentKey(s), text: segmentLabel(s) }));
  segSelect.createEl("option", { value: "::none", text: "No segment" });
  segSelect.value = filters.segment;

  const statusSelect = bar.createEl("select");
  statusSelect.createEl("option", { value: "", text: "Any status" });
  ["active", "planned", "offline", "retired"].forEach((s) => statusSelect.createEl("option", { value: s, text: s }));
  statusSelect.value = filters.status;

  const count = bar.createSpan({ cls: "brewin-lan-filter-count" });

  const table = root.createEl("table", { cls: "brewin-lan-table brewin-lan-device-table" });
  const head = table.createEl("thead").createEl("tr");
  // `secondary` columns are dropped on a narrow screen rather than pushing the table into a
  // sideways scroll — a phone can spare the MAC and the room, not the address.
  const columns: { label: string; sort?: DeviceFilters["sort"]; secondary?: boolean }[] = [
    { label: "" },
    { label: "Device", sort: "name" },
    { label: "Type", sort: "type" },
    { label: "Address", sort: "ip" },
    { label: "Segment" },
    { label: "MAC", secondary: true },
    { label: "Plugged into" },
    { label: "Where", secondary: true },
    { label: "Status", sort: "status" },
  ];
  const body = table.createEl("tbody");

  const draw = (): void => {
    body.empty();
    const rows = select(ctx, filters);
    count.setText(`${rows.length} of ${ctx.net.devices.length}`);
    if (rows.length === 0) {
      body.createEl("tr").createEl("td", { attr: { colspan: String(columns.length) }, cls: "brewin-lan-muted", text: "Nothing matches." });
      return;
    }
    for (const device of rows) {
      const tr = body.createEl("tr");
      const problems = ctx.issuesFor(device.path);
      const worst = problems.some((p) => p.severity === "error") ? "error" : problems.some((p) => p.severity === "warn") ? "warn" : null;

      const iconCell = tr.createEl("td", { cls: "brewin-lan-cell-icon" });
      const icon = iconCell.createDiv({ cls: "brewin-lan-row-icon" });
      setIcon(icon, typeIcon(device.type, ctx.settings.deviceTypes));
      if (worst) {
        const dot = iconCell.createSpan({ cls: `brewin-lan-dot is-${worst}` });
        dot.setAttr("aria-label", problems.map((p) => p.message).join("\n"));
        dot.setAttr("title", problems.map((p) => p.message).join("\n"));
      }

      const nameCell = tr.createEl("td");
      const link = nameCell.createSpan({ cls: "brewin-lan-link", text: device.title });
      link.addEventListener("click", () => ctx.open(device.path));
      const locate = nameCell.createSpan({ cls: "brewin-lan-locate", text: "◎" });
      locate.setAttr("aria-label", "Show on the diagram");
      locate.setAttr("title", "Show on the diagram");
      locate.addEventListener("click", () => ctx.focus(device.path));

      const typeCell = tr.createEl("td");
      typeCell.createSpan({ text: typeLabel(device.type, ctx.settings.deviceTypes) });
      // Only shown when the note says so: "not recorded" must not read as "unmanaged".
      if (device.managed !== null) {
        typeCell.createSpan({ cls: "brewin-lan-muted", text: device.managed ? " · managed" : " · unmanaged" });
      }

      const addressCell = tr.createEl("td", { cls: "brewin-lan-mono" });
      const addressed = device.ifaces.filter((i) => i.ip !== null);
      if (addressed.length === 0) addressCell.createSpan({ cls: "brewin-lan-muted", text: "—" });
      addressed.forEach((iface, i) => {
        if (i > 0) addressCell.createEl("br");
        addressCell.createSpan({ text: iface.prefix === null ? (iface.ip as string) : `${iface.ip}/${iface.prefix}` });
        if (addressed.length > 1) addressCell.createSpan({ cls: "brewin-lan-muted", text: ` ${iface.name}` });
      });

      const segCell = tr.createEl("td");
      const segments = [...new Set(ctx.net.placements.filter((p) => p.device.path === device.path && p.segment).map((p) => p.segment))];
      if (segments.length === 0) segCell.createSpan({ cls: "brewin-lan-muted", text: "—" });
      segments.forEach((segment) => {
        const chip = segCell.createDiv({ cls: "brewin-lan-segchip" });
        chip.createSpan({ cls: "brewin-lan-swatch" }).style.background = ctx.colourOf(segment);
        chip.createSpan({ text: segment ? segmentLabel(segment) : "" });
      });

      tr.createEl("td", { cls: "brewin-lan-mono brewin-lan-col-secondary", text: device.ifaces.find((i) => i.mac)?.mac ?? "—" });

      const uplinkCell = tr.createEl("td");
      if (device.uplink) {
        const parent = ctx.net.devices.find((d) => d.title.toLowerCase() === (device.uplink ?? "").toLowerCase());
        const text = device.uplink + linkPorts(device);
        if (parent) {
          const up = uplinkCell.createSpan({ cls: "brewin-lan-link", text });
          up.addEventListener("click", () => ctx.focus(parent.path));
        } else {
          uplinkCell.createSpan({ cls: "brewin-lan-broken", text });
        }
      } else {
        uplinkCell.createSpan({ cls: "brewin-lan-muted", text: "—" });
      }

      tr.createEl("td", { cls: "brewin-lan-col-secondary", text: device.location ?? "—" });
      tr.createEl("td").createSpan({ cls: `brewin-lan-status is-${device.status}`, text: device.status });
    }
  };

  columns.forEach((column) => {
    const th = head.createEl("th", { text: column.label, cls: column.secondary ? "brewin-lan-col-secondary" : undefined });
    if (!column.sort) return;
    th.addClass("is-sortable");
    if (filters.sort === column.sort) th.addClass("is-sorted");
    th.addEventListener("click", () => {
      filters.sort = column.sort as DeviceFilters["sort"];
      head.findAll("th").forEach((el) => el.removeClass("is-sorted"));
      th.addClass("is-sorted");
      draw();
    });
  });

  // Filters redraw the rows only, so typing never loses the caret.
  search.addEventListener("input", () => {
    filters.search = search.value;
    draw();
  });
  typeSelect.addEventListener("change", () => {
    filters.type = typeSelect.value;
    draw();
  });
  segSelect.addEventListener("change", () => {
    filters.segment = segSelect.value;
    draw();
  });
  statusSelect.addEventListener("change", () => {
    filters.status = statusSelect.value;
    draw();
  });

  draw();
}

function select(ctx: ViewContext, filters: DeviceFilters): Device[] {
  const needle = filters.search.trim().toLowerCase();
  const rows = ctx.net.devices.filter((device) => {
    if (!ctx.settings.includeRetired && device.status === "retired" && filters.status !== "retired") return false;
    if (filters.type && device.type !== filters.type) return false;
    if (filters.status && device.status !== filters.status) return false;
    if (filters.segment) {
      const segments = ctx.net.placements.filter((p) => p.device.path === device.path).map((p) => (p.segment ? segmentKey(p.segment) : "::none"));
      if (!segments.includes(filters.segment)) return false;
    }
    if (!needle) return true;
    const haystack = [
      device.title,
      device.hostname,
      device.type,
      device.location ?? "",
      device.uplink ?? "",
      ...device.ifaces.map((i) => `${i.ip ?? ""} ${i.mac ?? ""} ${i.name}`),
      ...device.services,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });

  const ipOf = (device: Device): string | null => device.ifaces.find((i) => i.ip !== null)?.ip ?? null;
  return rows.sort((a, b) => {
    switch (filters.sort) {
      case "type":
        return a.type.localeCompare(b.type) || a.title.localeCompare(b.title);
      case "status":
        return a.status.localeCompare(b.status) || a.title.localeCompare(b.title);
      case "ip": {
        const ai = ipOf(a);
        const bi = ipOf(b);
        if (ai && bi) return compareIps(ai, bi);
        if (ai) return -1;
        if (bi) return 1;
        return a.title.localeCompare(b.title);
      }
      default:
        return a.title.localeCompare(b.title);
    }
  });
}

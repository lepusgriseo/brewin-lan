// Turning the notes into configuration. Pure string generation, so what the export tab shows is
// exactly what the tests assert.
//
// The vault is already the place the network is written down; these functions make it the place
// the network is *configured* from, which is the only way the two stay in agreement. Anything that
// cannot be exported is reported as a skip with its reason rather than quietly omitted — a missing
// MAC is the difference between a reservation and a surprise.

import { compareIps } from "./ip";
import { Network } from "./network";
import { Device, Iface } from "./types";

export interface ExportOptions {
  /** The local domain names are qualified with, e.g. `rasputin.lan`. */
  domain: string;
  /** Include devices that are documented but not yet built. */
  includePlanned?: boolean;
}

export interface ExportResult {
  text: string;
  /** Lines actually emitted. */
  count: number;
  skipped: { device: string; reason: string }[];
}

interface Row {
  device: Device;
  iface: Iface;
}

/** Exportable addresses: real kit, real address, lowest address first. */
function rows(net: Network, opts: ExportOptions): { rows: Row[]; skipped: { device: string; reason: string }[] } {
  const skipped: { device: string; reason: string }[] = [];
  const out: Row[] = [];
  for (const device of net.devices) {
    if (device.status === "retired") continue;
    if (device.status === "planned" && !opts.includePlanned) {
      skipped.push({ device: device.title, reason: "planned, not built yet" });
      continue;
    }
    const addressed = device.ifaces.filter((i) => i.ip !== null);
    if (addressed.length === 0) {
      skipped.push({ device: device.title, reason: "no IPv4 address recorded" });
      continue;
    }
    for (const iface of addressed) out.push({ device, iface });
  }
  out.sort((a, b) => compareIps(a.iface.ip as string, b.iface.ip as string));
  return { rows: out, skipped };
}

/** A name for an interface: the hostname for the first address, `host-eth1` for the rest. */
function nameFor(device: Device, iface: Iface): string {
  const first = device.ifaces.find((i) => i.ip !== null);
  return first && first === iface ? device.hostname : `${device.hostname}-${iface.name}`;
}

/**
 * dnsmasq DHCP reservations — one per device, not one per address.
 *
 * A DHCP server binds an address to a MAC, so a multi-homed device gets exactly one reservation:
 * the interface that has both a MAC and an address, which for RasPutin is wlan0 rather than the
 * lab link or the tunnel. Anything without a MAC cannot be reserved at all and is reported as a
 * skip with the reason, because a silently missing reservation is how a "static" address quietly
 * moves one day.
 */
export function dnsmasqReservations(net: Network, opts: ExportOptions): ExportResult {
  const skipped: { device: string; reason: string }[] = [];
  const chosen: Row[] = [];
  for (const device of net.devices) {
    if (device.status === "retired") continue;
    if (device.status === "planned" && !opts.includePlanned) {
      skipped.push({ device: device.title, reason: "planned, not built yet" });
      continue;
    }
    const addressed = device.ifaces.filter((i) => i.ip !== null);
    if (addressed.length === 0) {
      skipped.push({ device: device.title, reason: "no IPv4 address recorded" });
      continue;
    }
    const iface = addressed.find((i) => i.mac !== null);
    if (!iface) {
      skipped.push({ device: device.title, reason: "no MAC recorded" });
      continue;
    }
    chosen.push({ device, iface });
  }
  chosen.sort((a, b) => compareIps(a.iface.ip as string, b.iface.ip as string));

  const lines: string[] = ["# DHCP reservations — generated from the vault, do not hand-edit"];
  for (const { device, iface } of chosen) lines.push(`dhcp-host=${iface.mac},${iface.ip},${device.hostname}`);
  return { text: lines.join("\n") + "\n", count: chosen.length, skipped };
}

/**
 * dnsmasq name records. `host-record` is used rather than `address=` because it answers the reverse
 * lookup as well, and a PTR is what mail servers and logs actually want (see `DNS Hostmastering`).
 */
export function dnsmasqHostRecords(net: Network, opts: ExportOptions): ExportResult {
  const { rows: all, skipped } = rows(net, opts);
  const lines: string[] = ["# Forward and reverse names — generated from the vault"];
  let count = 0;
  for (const { device, iface } of all) {
    const name = nameFor(device, iface);
    lines.push(`host-record=${name},${name}.${opts.domain},${iface.ip}`);
    count++;
  }
  return { text: lines.join("\n") + "\n", count, skipped };
}

/** A hosts file, for anything that has no local resolver. */
export function hostsFile(net: Network, opts: ExportOptions): ExportResult {
  const { rows: all, skipped } = rows(net, opts);
  const width = Math.max(0, ...all.map((r) => (r.iface.ip as string).length));
  const lines: string[] = ["# Generated from the vault"];
  let count = 0;
  for (const { device, iface } of all) {
    const name = nameFor(device, iface);
    lines.push(`${(iface.ip as string).padEnd(width)}  ${name}.${opts.domain} ${name}`);
    count++;
  }
  return { text: lines.join("\n") + "\n", count, skipped };
}

/** A markdown table, for pasting the inventory into a note. */
export function markdownTable(net: Network, opts: ExportOptions): ExportResult {
  const { rows: all, skipped } = rows(net, { ...opts, includePlanned: true });
  const lines = ["| Device | Type | Address | Segment | MAC | Port | Status |", "| --- | --- | --- | --- | --- | --- | --- |"];
  for (const { device, iface } of all) {
    const segment = net.placements.find((p) => p.device.path === device.path && p.iface === iface)?.segment;
    const port = device.uplink && device.uplinkPort !== null ? `${device.uplink}:${device.uplinkPort}` : device.uplink ?? "—";
    lines.push(
      `| [[${device.title}]] | ${device.type} | ${iface.ip}${iface.prefix !== null ? "/" + iface.prefix : ""} | ${
        segment ? (segment.vlanId === null ? segment.title : `VLAN ${segment.vlanId}`) : "—"
      } | ${iface.mac ?? "—"} | ${port} | ${device.status} |`
    );
  }
  return { text: lines.join("\n") + "\n", count: all.length, skipped };
}

/** CSV, for a spreadsheet or an import into something else. */
export function csvExport(net: Network, opts: ExportOptions): ExportResult {
  const { rows: all, skipped } = rows(net, { ...opts, includePlanned: true });
  const escape = (value: string): string => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const lines = ["device,hostname,type,status,interface,ip,prefix,mac,vlan,segment,uplink,uplink_port,location"];
  for (const { device, iface } of all) {
    const segment = net.placements.find((p) => p.device.path === device.path && p.iface === iface)?.segment;
    lines.push(
      [
        device.title,
        device.hostname,
        device.type,
        device.status,
        iface.name,
        iface.ip ?? "",
        iface.prefix === null ? "" : String(iface.prefix),
        iface.mac ?? "",
        iface.vlan === null ? (segment?.vlanId ?? "") : iface.vlan,
        segment?.title ?? "",
        device.uplink ?? "",
        device.uplinkPort === null ? "" : String(device.uplinkPort),
        device.location ?? "",
      ]
        .map((v) => escape(String(v)))
        .join(",")
    );
  }
  return { text: lines.join("\n") + "\n", count: all.length, skipped };
}

export type ExportFormat = "dnsmasq-dhcp" | "dnsmasq-dns" | "hosts" | "markdown" | "csv";

export const EXPORT_LABELS: Record<ExportFormat, string> = {
  "dnsmasq-dhcp": "dnsmasq — DHCP reservations",
  "dnsmasq-dns": "dnsmasq — names (forward + reverse)",
  hosts: "/etc/hosts",
  markdown: "Markdown table",
  csv: "CSV",
};

export function runExport(format: ExportFormat, net: Network, opts: ExportOptions): ExportResult {
  switch (format) {
    case "dnsmasq-dhcp":
      return dnsmasqReservations(net, opts);
    case "dnsmasq-dns":
      return dnsmasqHostRecords(net, opts);
    case "hosts":
      return hostsFile(net, opts);
    case "markdown":
      return markdownTable(net, opts);
    case "csv":
      return csvExport(net, opts);
  }
}

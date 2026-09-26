// Ties the two note kinds together: which segment each address belongs to, which device an
// `uplink:` points at, and what is still free. Pure — no Obsidian imports.
//
// Every other module works from this, so the rules for "which VLAN is this address on" live in
// exactly one place: an explicit `vlan:` on the interface wins, and otherwise the address is
// matched against the segments' CIDRs, longest prefix first — the same order a routing table uses.

import { compareIps, inAnyRange, inRange, inSubnet, ipToInt, nextFreeIp } from "./ip";
import { Device, Iface, IpRange, Segment } from "./types";

/** One address, once it knows where it lives. */
export interface Placement {
  device: Device;
  iface: Iface;
  /** Null when the address matches no known segment, or there is no address at all. */
  segment: Segment | null;
  ipInt: number | null;
}

export interface Network {
  devices: Device[];
  segments: Segment[];
  placements: Placement[];
  /** Stable colour slot per segment, in the order segments are given. */
  segmentIndex: Map<string, number>;
  byPath: Map<string, Device>;
}

/** Segments are identified by note path, falling back to title for ones built from settings. */
export function segmentKey(segment: Segment): string {
  return segment.path ?? `title:${segment.title.toLowerCase()}`;
}

export function segmentLabel(segment: Segment): string {
  return segment.vlanId === null ? segment.title : `VLAN ${segment.vlanId} · ${segment.title}`;
}

/** The segment an address sits in: an explicit VLAN tag first, then longest-prefix match. */
export function segmentFor(iface: Iface, segments: Segment[]): Segment | null {
  if (iface.vlan !== null) {
    const tagged = segments.find((s) => s.vlanId === iface.vlan);
    if (tagged) return tagged;
  }
  const ip = iface.ip === null ? null : ipToInt(iface.ip);
  if (ip === null) return null;
  const matches = segments.filter((s) => s.cidr && inSubnet(ip, s.cidr));
  if (matches.length === 0) return null;
  return matches.sort((a, b) => (b.cidr?.prefix ?? 0) - (a.cidr?.prefix ?? 0))[0];
}

export function buildNetwork(devices: Device[], segments: Segment[]): Network {
  const placements: Placement[] = [];
  for (const device of devices) {
    for (const iface of device.ifaces) {
      placements.push({ device, iface, segment: segmentFor(iface, segments), ipInt: iface.ip === null ? null : ipToInt(iface.ip) });
    }
  }
  const segmentIndex = new Map<string, number>();
  segments.forEach((s, i) => segmentIndex.set(segmentKey(s), i));
  return {
    devices,
    segments,
    placements,
    segmentIndex,
    byPath: new Map(devices.map((d) => [d.path, d])),
  };
}

/**
 * Finds the device an `uplink:` names. Notes refer to each other by title, but a hostname or a
 * path is just as likely to be typed, so all three resolve.
 */
export function resolveDevice(name: string | null, devices: Device[]): Device | null {
  if (!name) return null;
  const needle = name.trim().toLowerCase();
  if (!needle) return null;
  return (
    devices.find((d) => d.title.toLowerCase() === needle) ??
    devices.find((d) => d.hostname.toLowerCase() === needle) ??
    devices.find((d) => d.path.toLowerCase().endsWith("/" + needle + ".md")) ??
    null
  );
}

/** Every address in use on a segment, as integers — what "next free" has to avoid. */
export function usedIn(net: Network, segment: Segment): number[] {
  const key = segmentKey(segment);
  return net.placements
    .filter((p) => p.segment !== null && segmentKey(p.segment) === key && p.ipInt !== null && p.device.status !== "retired")
    .map((p) => p.ipInt as number);
}

export interface FreeAddressOptions {
  /** Keep out of the DHCP pool — right for a server, wrong for a phone. */
  avoidPool?: boolean;
  /** Keep out of the segment's reserved ranges. */
  avoidReserved?: boolean;
  from?: string;
}

/** The address to offer for a new device on this segment, or null if there is nothing sensible. */
export function nextFreeIn(net: Network, segment: Segment, opts: FreeAddressOptions = {}): string | null {
  if (!segment.cidr) return null;
  const avoid: IpRange[] = [];
  if (opts.avoidPool !== false && segment.pool) avoid.push(segment.pool);
  if (opts.avoidReserved !== false) avoid.push(...segment.reserved);
  const gateway = segment.gateway === null ? null : ipToInt(segment.gateway);
  const used = usedIn(net, segment);
  if (gateway !== null) used.push(gateway);
  const from = opts.from ? ipToInt(opts.from) ?? undefined : undefined;
  return nextFreeIp(segment.cidr, { used, avoid, from });
}

/** Is this address inside the segment's DHCP pool? Cheap, but asked in three places. */
export function inPool(ipInt: number, segment: Segment): boolean {
  return segment.pool !== null && inRange(ipInt, segment.pool);
}

export function isReserved(ipInt: number, segment: Segment): boolean {
  return inAnyRange(ipInt, segment.reserved);
}

/** Devices on a segment, sorted by address so the listing reads like a subnet walk. */
export function devicesOn(net: Network, segment: Segment): Placement[] {
  const key = segmentKey(segment);
  return net.placements
    .filter((p) => p.segment !== null && segmentKey(p.segment) === key)
    .sort((a, b) => {
      if (a.iface.ip && b.iface.ip) return compareIps(a.iface.ip, b.iface.ip);
      if (a.iface.ip) return -1;
      if (b.iface.ip) return 1;
      return a.device.title.localeCompare(b.device.title);
    });
}

export interface ParentLink {
  device: Device;
  /** The device it plugs into, once resolved and once any loop has been cut. */
  parent: Device | null;
  /** Named an uplink that matched no device. */
  detached: boolean;
  /** The parent this link originally named, when it had to be cut to break a loop. */
  cutParent: string | null;
  port: number | null;
}

/**
 * Resolves every `uplink:` and cuts any loop it finds.
 *
 * A loop is not hypothetical — two switches each naming the other as its uplink is an easy typo,
 * and a tidy-tree layout over a cyclic graph never terminates. The link that closes the loop is
 * cut for layout purposes and remembered in `cutParent`, so the diagram still draws and the health
 * panel can still report the mistake.
 */
export function parentLinks(devices: Device[]): ParentLink[] {
  const byPath = new Map(devices.map((d) => [d.path, d]));
  const rows: ParentLink[] = devices.map((device) => {
    const target = resolveDevice(device.uplink, devices);
    const parent = target && target.path !== device.path ? target : null;
    return {
      device,
      parent,
      detached: device.uplink !== null && parent === null,
      // A device naming itself is its own kind of loop, and the only one worth calling out here.
      cutParent: target && target.path === device.path ? device.path : null,
      port: device.uplinkPort,
    };
  });
  const parentOf = new Map(rows.map((r) => [r.device.path, r.parent?.path ?? null]));

  for (const row of rows) {
    const seen = new Set<string>([row.device.path]);
    let cursor = parentOf.get(row.device.path) ?? null;
    while (cursor) {
      if (seen.has(cursor)) {
        row.cutParent = row.parent?.path ?? cursor;
        row.parent = null;
        parentOf.set(row.device.path, null);
        break;
      }
      seen.add(cursor);
      if (!byPath.has(cursor)) break;
      cursor = parentOf.get(cursor) ?? null;
    }
  }
  return rows;
}

/** Addresses with no segment at all — the ones a new segment note would explain. */
export function unplaced(net: Network): Placement[] {
  return net.placements.filter((p) => p.segment === null && p.ipInt !== null);
}

// The topology diagram's geometry. Pure — the view only draws what this returns, which is what
// makes the layout testable and keeps the drawing code free of arithmetic.
//
// Two readings of the same network:
//   tree  — the physical spine: internet → router → switches → leaves, laid out tidily so each
//           parent sits over the middle of its children.
//   vlan  — one horizontal band per segment, infrastructure on top, with the uplink edges still
//           drawn so the crossings show which devices sit on which VLAN.

import { hostsOthers, DeviceType } from "./deviceTypes";
import { compareIps } from "./ip";
import { Network, parentLinks, segmentKey } from "./network";
import { Device, DeviceStatus, Segment } from "./types";

export const INTERNET_ID = "::internet";

export type LayoutMode = "tree" | "vlan";

export interface TopoNode {
  /** Device note path, or `::internet` for the synthetic cloud. */
  id: string;
  title: string;
  /** Device-type id, or `internet`. */
  type: string;
  status: DeviceStatus | "synthetic";
  x: number;
  y: number;
  depth: number;
  /** The segment of the first addressed interface — what colours the node. */
  segment: Segment | null;
  /** Primary address, for the label under the title. */
  ip: string | null;
  /** Had an `uplink:` that pointed at nothing — drawn apart, and reported by the health check. */
  detached: boolean;
  device: Device | null;
}

export interface TopoEdge {
  /** The uplink (parent) end. */
  from: string;
  to: string;
  /** Port at the parent's end of the link, when the child names one. */
  port: number | null;
  /** Port at the child's own end. */
  toPort: number | null;
  /** The parent's port config calls this port a trunk. */
  trunk: boolean;
  /** This link closed a loop and was broken to lay the diagram out. */
  cycle: boolean;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Topology {
  nodes: TopoNode[];
  edges: TopoEdge[];
  bounds: Bounds;
  roots: string[];
  /** Band labels, in `vlan` mode only — the y order of the diagram. */
  bands: { label: string; y: number; segment: Segment | null }[];
}

export interface LayoutOptions {
  mode: LayoutMode;
  /** Horizontal distance between neighbouring devices. */
  nodeSpacing: number;
  /** Vertical distance between tree levels, or between VLAN bands. */
  levelSpacing: number;
  /** Draw the internet above the routers. */
  showInternet: boolean;
  types: DeviceType[];
  /** Hide retired kit unless asked for. */
  includeRetired?: boolean;
}

/** The address a node is labelled with: the first interface that has one. */
function primaryIp(device: Device): string | null {
  return device.ifaces.find((i) => i.ip !== null)?.ip ?? null;
}

function primarySegment(net: Network, device: Device): Segment | null {
  const placed = net.placements.find((p) => p.device.path === device.path && p.segment !== null && p.ipInt !== null);
  return placed?.segment ?? net.placements.find((p) => p.device.path === device.path && p.segment !== null)?.segment ?? null;
}

/**
 * Spine first, then by device type, then alphabetically.
 *
 * Ordering the spine by type rather than by name is what makes the diagram read the way people
 * draw these by hand: the wired chain (router, firewall, switch) runs down the left and the
 * wireless kit (AP, extender) sits to its right, instead of the alphabet deciding.
 */
function childOrder(a: Device, b: Device, types: DeviceType[]): number {
  const spine = Number(hostsOthers(b.type, types)) - Number(hostsOthers(a.type, types));
  if (spine !== 0) return spine;
  const rank = (id: string): number => {
    const index = types.findIndex((t) => t.id === id);
    return index === -1 ? types.length : index;
  };
  return rank(a.type) - rank(b.type) || a.title.localeCompare(b.title);
}

function isGateway(device: Device, types: DeviceType[]): boolean {
  return hostsOthers(device.type, types) && (device.type === "router" || device.type === "firewall");
}

function boundsOf(nodes: TopoNode[]): Bounds {
  if (nodes.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return {
    minX: Math.min(...nodes.map((n) => n.x)),
    minY: Math.min(...nodes.map((n) => n.y)),
    maxX: Math.max(...nodes.map((n) => n.x)),
    maxY: Math.max(...nodes.map((n) => n.y)),
  };
}

export function buildTopology(net: Network, opts: LayoutOptions): Topology {
  const devices = net.devices.filter((d) => opts.includeRetired || d.status !== "retired");
  if (devices.length === 0) return { nodes: [], edges: [], bounds: boundsOf([]), roots: [], bands: [] };

  const rows = parentLinks(devices);
  const rowOf = new Map(rows.map((r) => [r.device.path, r]));
  // A cut link is still drawn — dashed, and labelled a loop — because hiding it would hide the bug.
  const cycles: TopoEdge[] = rows
    .filter((r) => r.cutParent !== null)
    .map((r) => ({ from: r.cutParent as string, to: r.device.path, port: r.port, toPort: r.localPort, trunk: false, cycle: true }));

  const node = (device: Device, depth: number, x: number, y: number): TopoNode => ({
    id: device.path,
    title: device.title,
    type: device.type,
    status: device.status,
    x,
    y,
    depth,
    segment: primarySegment(net, device),
    ip: primaryIp(device),
    detached: rowOf.get(device.path)?.detached ?? false,
    device,
  });

  const edges: TopoEdge[] = [];
  for (const row of rows) {
    if (!row.parent) continue;
    const trunk = row.port !== null && row.parent.portConfig.some((p) => p.port === row.port && p.mode === "trunk");
    edges.push({ from: row.parent.path, to: row.device.path, port: row.port, toPort: row.localPort, trunk, cycle: false });
  }
  edges.push(...cycles);

  const nodes: TopoNode[] = [];
  const roots = rows.filter((r) => !r.parent).map((r) => r.device);

  if (opts.mode === "vlan") {
    // Bands: infrastructure, then one per segment that has anything on it, then the strays.
    const spine = devices.filter((d) => hostsOthers(d.type, opts.types)).sort((a, b) => childOrder(a, b, opts.types));
    const spinePaths = new Set(spine.map((d) => d.path));
    const bands: { label: string; y: number; segment: Segment | null }[] = [];
    let band = 0;

    const placeBand = (label: string, segment: Segment | null, members: Device[]): void => {
      if (members.length === 0) return;
      const y = band * opts.levelSpacing;
      bands.push({ label, y, segment });
      members.forEach((device, i) => nodes.push(node(device, band, i * opts.nodeSpacing, y)));
      band++;
    };

    placeBand("Infrastructure", null, spine);
    for (const segment of net.segments) {
      const key = segmentKey(segment);
      const members = devices
        .filter((d) => !spinePaths.has(d.path) && primarySegment(net, d) !== null && segmentKey(primarySegment(net, d) as Segment) === key)
        .sort((a, b) => {
          const ai = primaryIp(a);
          const bi = primaryIp(b);
          if (ai && bi) return compareIps(ai, bi);
          return a.title.localeCompare(b.title);
        });
      placeBand(segment.vlanId === null ? segment.title : `VLAN ${segment.vlanId} · ${segment.title}`, segment, members);
    }
    const strays = devices.filter((d) => !spinePaths.has(d.path) && primarySegment(net, d) === null).sort((a, b) => a.title.localeCompare(b.title));
    placeBand("No segment", null, strays);

    // Bands are centred on the widest one so the diagram doesn't drift left.
    const widest = Math.max(...bands.map((b) => nodes.filter((n) => n.y === b.y).length));
    for (const b of bands) {
      const inBand = nodes.filter((n) => n.y === b.y);
      const shift = ((widest - inBand.length) * opts.nodeSpacing) / 2;
      inBand.forEach((n) => (n.x += shift));
    }
    return { nodes, edges, bounds: boundsOf(nodes), roots: roots.map((r) => r.path), bands };
  }

  // ── Tidy tree ──────────────────────────────────────────────────────────────
  const children = new Map<string, Device[]>();
  for (const row of rows) {
    if (!row.parent) continue;
    const list = children.get(row.parent.path) ?? [];
    list.push(row.device);
    children.set(row.parent.path, list);
  }
  for (const list of children.values()) list.sort((a, b) => childOrder(a, b, opts.types));

  const gateways = roots.filter((d) => isGateway(d, opts.types));
  const showInternet = opts.showInternet && gateways.length > 0;
  const rootDepth = showInternet ? 1 : 0;

  let nextLeaf = 0;
  /** Post-order walk: a leaf takes the next column, a parent centres over its children. */
  const place = (device: Device, depth: number): number => {
    const kids = children.get(device.path) ?? [];
    let x: number;
    if (kids.length === 0) {
      x = nextLeaf++;
    } else {
      const xs = kids.map((kid) => place(kid, depth + 1));
      x = (Math.min(...xs) + Math.max(...xs)) / 2;
    }
    nodes.push(node(device, depth, x * opts.nodeSpacing, depth * opts.levelSpacing));
    return x;
  };

  const ordered = [...roots].sort((a, b) => childOrder(a, b, opts.types));
  const rootXs: number[] = [];
  for (const root of ordered) {
    rootXs.push(place(root, rootDepth));
    nextLeaf += 1; // a column of air between one root's subtree and the next
  }

  if (showInternet) {
    const gatewayXs = nodes.filter((n) => gateways.some((g) => g.path === n.id)).map((n) => n.x);
    const x = gatewayXs.length ? (Math.min(...gatewayXs) + Math.max(...gatewayXs)) / 2 : 0;
    nodes.push({
      id: INTERNET_ID,
      title: "Internet",
      type: "internet",
      status: "synthetic",
      x,
      y: 0,
      depth: 0,
      segment: null,
      ip: null,
      detached: false,
      device: null,
    });
    for (const gateway of gateways) edges.push({ from: INTERNET_ID, to: gateway.path, port: null, toPort: null, trunk: false, cycle: false });
  }

  // Drawn parents before children, which is also a sensible tab order.
  nodes.sort((a, b) => a.depth - b.depth || a.x - b.x || a.title.localeCompare(b.title));
  return { nodes, edges, bounds: boundsOf(nodes), roots: ordered.map((r) => r.path), bands: [] };
}

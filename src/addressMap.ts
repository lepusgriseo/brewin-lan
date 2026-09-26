// The address space of one segment, cell by cell — the answer to "what's free" and "who has .51".
// Pure, and capped: a /16 has 65,534 hosts and drawing a cell for each would be a picture of
// nothing, so anything bigger than the cap reports itself truncated and the view lists instead.

import { broadcastOf, hostRange, intToIp, ipToInt, usableHosts } from "./ip";
import { devicesOn, inPool, isReserved, Network, Placement } from "./network";
import { Segment } from "./types";

export type CellState = "network" | "broadcast" | "gateway" | "device" | "pool" | "reserved" | "free";

export interface AddressCell {
  ip: string;
  ipInt: number;
  state: CellState;
  /** Set when a device holds this address. */
  placement: Placement | null;
  /** Inside the DHCP pool, whoever holds it — worth showing under a device cell too. */
  inPool: boolean;
  reserved: boolean;
}

export interface SegmentStats {
  /** Usable host addresses in the subnet. */
  usable: number;
  /** Addresses a device documents. */
  used: number;
  /** Addresses inside the DHCP pool. */
  pool: number;
  /** Addresses inside a reserved range. */
  reserved: number;
  /** Free and outside both pool and reservations — what a static assignment can take. */
  freeStatic: number;
  /** Used as a share of usable, 0–1. */
  utilisation: number;
}

export interface AddressMap {
  segment: Segment;
  cells: AddressCell[];
  stats: SegmentStats;
  /** True when the subnet is too big to draw; `cells` is then empty. */
  truncated: boolean;
}

export interface AddressMapOptions {
  /** Above this many addresses the grid is refused rather than drawn. */
  maxCells?: number;
}

export function addressMap(net: Network, segment: Segment, opts: AddressMapOptions = {}): AddressMap {
  const stats: SegmentStats = { usable: 0, used: 0, pool: 0, reserved: 0, freeStatic: 0, utilisation: 0 };
  if (!segment.cidr) return { segment, cells: [], stats, truncated: false };

  const held = new Map<number, Placement>();
  for (const placement of devicesOn(net, segment)) {
    if (placement.ipInt !== null && !held.has(placement.ipInt)) held.set(placement.ipInt, placement);
  }
  const gateway = segment.gateway === null ? null : ipToInt(segment.gateway);
  const { start, end } = hostRange(segment.cidr);
  const size = end - start + 1;
  stats.usable = usableHosts(segment.cidr.prefix);

  const max = opts.maxCells ?? 1024;
  const truncated = size > max;
  const cells: AddressCell[] = [];

  for (let ip = start; ip <= end; ip++) {
    const placement = held.get(ip) ?? null;
    const pooled = inPool(ip, segment);
    const reserved = isReserved(ip, segment);
    if (placement) stats.used++;
    if (pooled) stats.pool++;
    if (reserved) stats.reserved++;
    if (!placement && !pooled && !reserved) stats.freeStatic++;
    if (truncated) continue;

    const state: CellState = placement ? (ip === gateway ? "gateway" : "device") : ip === gateway ? "gateway" : reserved ? "reserved" : pooled ? "pool" : "free";
    cells.push({ ip: intToIp(ip), ipInt: ip, state, placement, inPool: pooled, reserved });
  }

  // The network and broadcast addresses are drawn for context on anything wider than a /31, where
  // they exist and can never be handed out.
  if (!truncated && segment.cidr.prefix <= 30) {
    cells.unshift({ ip: intToIp(segment.cidr.network), ipInt: segment.cidr.network, state: "network", placement: null, inPool: false, reserved: false });
    const bcast = broadcastOf(segment.cidr);
    cells.push({ ip: intToIp(bcast), ipInt: bcast, state: "broadcast", placement: null, inPool: false, reserved: false });
  }

  stats.utilisation = stats.usable > 0 ? stats.used / stats.usable : 0;
  return { segment, cells, stats, truncated };
}

/** Segment summaries for the overview row, ordered as the segments were given. */
export function allSegmentStats(net: Network, opts: AddressMapOptions = {}): { segment: Segment; stats: SegmentStats }[] {
  return net.segments.map((segment) => ({ segment, stats: addressMap(net, segment, { maxCells: opts.maxCells ?? 0 }).stats }));
}

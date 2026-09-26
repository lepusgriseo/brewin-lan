// IPv4 arithmetic. No Obsidian imports, no dependencies — every address question the plugin asks
// is answered here so that the awkward cases (prefix 0, /31 links, a pool written as a short
// range) are settled once and tested once.
//
// Addresses are handled as unsigned 32-bit integers. JavaScript bit operations are signed, so
// every shift is followed by `>>> 0`.

import { Cidr, IpRange } from "./types";

const QUAD = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Dotted quad → integer, or null if it isn't one. Rejects octets over 255. */
export function ipToInt(text: string): number | null {
  const m = QUAD.exec(text.trim());
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i]);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    n = (n * 256 + octet) >>> 0;
  }
  return n >>> 0;
}

export function intToIp(n: number): string {
  const u = n >>> 0;
  return [(u >>> 24) & 255, (u >>> 16) & 255, (u >>> 8) & 255, u & 255].join(".");
}

export function isIpv4(text: string): boolean {
  return ipToInt(text) !== null;
}

/** Crude on purpose: anything with two colons in it is treated as IPv6 and kept aside. */
export function isIpv6(text: string): boolean {
  const addr = text.trim().split("%")[0].split("/")[0];
  return /^[0-9a-fA-F:]+$/.test(addr) && (addr.match(/:/g) ?? []).length >= 2;
}

/** Prefix length → netmask. Prefix 0 is a real case (a default route), and `<< 32` would wrap. */
export function maskOf(prefix: number): number {
  if (prefix <= 0) return 0;
  if (prefix >= 32) return 0xffffffff >>> 0;
  return (0xffffffff << (32 - prefix)) >>> 0;
}

export function maskToPrefix(mask: string): number | null {
  const n = ipToInt(mask);
  if (n === null) return null;
  // A netmask is contiguous ones followed by contiguous zeros; anything else is not a mask.
  const inverted = ~n >>> 0;
  if (((inverted + 1) & inverted) >>> 0) return null;
  let prefix = 0;
  for (let i = 31; i >= 0; i--) {
    if ((n >>> i) & 1) prefix++;
    else break;
  }
  return prefix;
}

export function networkOf(ip: number, prefix: number): number {
  return (ip & maskOf(prefix)) >>> 0;
}

export function broadcastOf(cidr: Cidr): number {
  return (cidr.network | (~maskOf(cidr.prefix) >>> 0)) >>> 0;
}

/** `192.168.0.0/24` → a Cidr, normalised to the network address even if a host address was given. */
export function parseCidr(text: string): Cidr | null {
  const [addr, len] = text.trim().split("/");
  const ip = addr === undefined ? null : ipToInt(addr);
  if (ip === null) return null;
  const prefix = len === undefined ? 32 : Number(len);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  return { network: networkOf(ip, prefix), prefix };
}

export function formatCidr(cidr: Cidr): string {
  return `${intToIp(cidr.network)}/${cidr.prefix}`;
}

/**
 * An address as a note is likely to write it, which is not always tidy:
 * `192.168.0.51/24`, `192.168.0.51 /24`, `192.168.0.51 255.255.255.0`, or a bare `192.168.0.51`.
 * Returns the host address and the prefix separately — the host part matters, so unlike
 * `parseCidr` this does not collapse to the network.
 */
export function parseAddress(text: string): { ip: string; prefix: number | null } | null {
  const cleaned = text.trim();
  const slash = /^(\d{1,3}(?:\.\d{1,3}){3})\s*\/\s*(\d{1,2})\b/.exec(cleaned);
  if (slash) {
    const ip = ipToInt(slash[1]);
    const prefix = Number(slash[2]);
    if (ip === null || prefix > 32) return null;
    return { ip: intToIp(ip), prefix };
  }
  const withMask = /^(\d{1,3}(?:\.\d{1,3}){3})\s+(\d{1,3}(?:\.\d{1,3}){3})\b/.exec(cleaned);
  if (withMask) {
    const ip = ipToInt(withMask[1]);
    const prefix = maskToPrefix(withMask[2]);
    if (ip !== null && prefix !== null) return { ip: intToIp(ip), prefix };
  }
  const bare = /^(\d{1,3}(?:\.\d{1,3}){3})\b/.exec(cleaned);
  if (bare) {
    const ip = ipToInt(bare[1]);
    if (ip !== null) return { ip: intToIp(ip), prefix: null };
  }
  return null;
}

export function inSubnet(ip: number, cidr: Cidr): boolean {
  return networkOf(ip, cidr.prefix) === cidr.network;
}

/** Usable host addresses. A /31 point-to-point link has two, a /32 has one — neither reserves a
 *  broadcast address, and pretending otherwise would report a lab link as full. */
export function usableHosts(prefix: number): number {
  if (prefix >= 31) return prefix === 32 ? 1 : 2;
  return Math.pow(2, 32 - prefix) - 2;
}

/** The first and last address a host may take in a subnet. */
export function hostRange(cidr: Cidr): IpRange {
  if (cidr.prefix >= 31) return { start: cidr.network, end: broadcastOf(cidr) };
  return { start: (cidr.network + 1) >>> 0, end: (broadcastOf(cidr) - 1) >>> 0 };
}

export function cidrsOverlap(a: Cidr, b: Cidr): boolean {
  const shorter = Math.min(a.prefix, b.prefix);
  return networkOf(a.network, shorter) === networkOf(b.network, shorter);
}

/**
 * A range as a segment note writes it: `192.168.0.100-192.168.0.199`, the common shorthand
 * `192.168.0.100-199`, or a single address. Returns null rather than guessing when the halves
 * disagree about which subnet they are in.
 */
export function parseRange(text: string): IpRange | null {
  const parts = text.split(/\s*[-–]\s*/);
  if (parts.length === 1) {
    const only = ipToInt(parts[0].trim());
    return only === null ? null : { start: only, end: only };
  }
  if (parts.length !== 2) return null;
  const start = ipToInt(parts[0].trim());
  if (start === null) return null;
  const tail = parts[1].trim();
  let end = ipToInt(tail);
  if (end === null && /^\d{1,3}$/.test(tail)) {
    const lastOctet = Number(tail);
    if (lastOctet > 255) return null;
    end = ((start & 0xffffff00) >>> 0) + lastOctet;
  }
  if (end === null || end < start) return null;
  return { start: start >>> 0, end: end >>> 0 };
}

export function formatRange(range: IpRange): string {
  return range.start === range.end ? intToIp(range.start) : `${intToIp(range.start)}–${intToIp(range.end)}`;
}

export function inRange(ip: number, range: IpRange): boolean {
  return ip >= range.start && ip <= range.end;
}

export function inAnyRange(ip: number, ranges: IpRange[]): boolean {
  return ranges.some((r) => inRange(ip, r));
}

export interface NextFreeOptions {
  /** Addresses already in use. */
  used: Iterable<number>;
  /** Ranges to stay out of — the DHCP pool and anything reserved. */
  avoid?: IpRange[];
  /** Start looking here instead of at the bottom of the subnet. */
  from?: number;
  /** Safety valve: never walk more than this many addresses (a /8 is 16 million). */
  scanLimit?: number;
}

/**
 * The lowest free address in a subnet, skipping what is in use, the DHCP pool and any reserved
 * range. Returns null when there is nothing left — or nothing left within the scan limit, which
 * for a subnet larger than /12 is the same answer in practice.
 */
export function nextFreeIp(cidr: Cidr, opts: NextFreeOptions): string | null {
  const used = new Set<number>();
  for (const u of opts.used) used.add(u >>> 0);
  const { start, end } = hostRange(cidr);
  const first = Math.max(start, (opts.from ?? start) >>> 0);
  const limit = opts.scanLimit ?? 1 << 20;
  let scanned = 0;
  for (let ip = first; ip <= end; ip++) {
    if (++scanned > limit) return null;
    if (used.has(ip >>> 0)) continue;
    if (opts.avoid && inAnyRange(ip >>> 0, opts.avoid)) continue;
    return intToIp(ip);
  }
  return null;
}

/** Normalises a MAC to lower-case colon form so two spellings of one address compare equal. */
export function normaliseMac(text: string): string | null {
  const hex = text.trim().toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length !== 12) return null;
  return (hex.match(/.{2}/g) ?? []).join(":");
}

/** Sorts dotted quads numerically — `.9` before `.10`, which a string sort gets wrong. */
export function compareIps(a: string, b: string): number {
  return (ipToInt(a) ?? 0) - (ipToInt(b) ?? 0);
}

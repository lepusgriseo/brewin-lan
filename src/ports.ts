// Physical ports: what each one is made of, how fast it can go, and whether two of them can
// actually be cabled together. Pure — no Obsidian imports.
//
// Two sources, deliberately kept apart, because they answer different questions and change at
// different rates:
//
//   `port_groups:` is **hardware** — "ports 1–8 are 1G RJ45, port 12 is a 10G SFP+ cage". It is
//                  written once per device, in ranges, because that is how switches are specified.
//   `port_config:` is **configuration** — per port: access or trunk, which VLAN, a label. It may
//                  also override a hardware field for one odd port.
//
// Everything else works from `resolvePort`, so the precedence lives in one place.

import { Device, PortConfig, PortGroup } from "./types";

export type PortMedium = "copper" | "fibre";

/** Speeds are held in Mbit/s so that 2.5G, 100M and 10G are one comparable number. */
export const SPEED_UNITS: Record<string, number> = { m: 1, mb: 1, mbe: 1, mbps: 1, mbit: 1, g: 1000, gb: 1000, gbe: 1000, gbps: 1000, gbit: 1000, t: 1_000_000 };

/** `1000BASE-T` is copper, `10GBASE-SR` is not — the suffix says so, so it need not be repeated. */
const BASE_COPPER = /base-?(t|tx|t1|cx|kx)\b/i;
const BASE_FIBRE = /base-?(s|l|e|z|b)[rxw]?\b/i;

const CONNECTOR_MEDIUM: Record<string, PortMedium> = {
  rj45: "copper",
  "rj-45": "copper",
  copper: "copper",
  dac: "copper",
  lc: "fibre",
  sc: "fibre",
  st: "fibre",
  mpo: "fibre",
  mtp: "fibre",
  fc: "fibre",
};

/**
 * One speed token → Mbit/s. `10G`, `2.5GbE`, `100M`, `1000BASE-T`, `10GBASE-SR`, or a bare number
 * whose unit the caller supplies.
 */
export function parseSpeed(text: string, defaultUnit: number | null = null): number | null {
  const token = text.trim().toLowerCase();
  if (!token) return null;
  const m = /^(\d+(?:\.\d+)?)\s*([a-z]*)/.exec(token);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const suffix = m[2];
  const unitWord = suffix.replace(/base.*$/, "");
  // `1000BASE-T` carries its unit in the standard's own naming: the number is Mbit/s, which is why
  // it is 1000 and not 1. `10GBASE-SR` says the G itself, and is handled by the ordinary path.
  const unit = unitWord ? SPEED_UNITS[unitWord] : /^base/.test(suffix) ? 1 : defaultUnit;
  if (!unit) return null;
  return Math.round(value * unit);
}

/**
 * A port's capable speeds, however they are written: `2.5G`, `1G/2.5G/5G/10G`, the classic
 * `10/100/1000`, a list, or a single number.
 *
 * Unitless tokens borrow the unit from whichever token in the list did give one — `1/2.5/5/10G` is
 * four gigabit speeds, not three unknowns and a 10. With no unit anywhere it falls back to the
 * classic notation (`10/100/1000` is Mbit/s) unless a value is small or fractional, which nobody
 * means in Mbit/s.
 */
export function parseSpeeds(value: unknown): number[] {
  const raw = (Array.isArray(value) ? value : [value])
    .filter((v) => v !== null && v !== undefined && v !== "")
    .flatMap((v) => String(v).split(/[,/|]|\s+(?:and|or)\s+/i))
    .map((s) => s.trim())
    .filter(Boolean);
  if (raw.length === 0) return [];

  // The unit any token names, taken from the last one that names one — people write it once, at
  // the end: `1/2.5/5/10G`.
  let stated: number | null = null;
  for (const token of raw) {
    const m = /^\d+(?:\.\d+)?\s*([a-z]+)/i.exec(token);
    const unit = m ? SPEED_UNITS[m[1].toLowerCase().replace(/base.*$/, "")] : undefined;
    if (unit) stated = unit;
  }
  let fallback = stated;
  if (fallback === null) {
    const numbers = raw.map((t) => Number(/^\d+(?:\.\d+)?/.exec(t)?.[0] ?? NaN));
    const classic = numbers.every((n) => Number.isInteger(n) && n >= 10);
    fallback = classic ? 1 : 1000;
  }

  const speeds = raw.map((token) => parseSpeed(token, fallback)).filter((n): n is number => n !== null);
  return [...new Set(speeds)].sort((a, b) => a - b);
}

/** 100 → `100M`, 1000 → `1G`, 2500 → `2.5G`. */
export function formatSpeed(mbps: number): string {
  if (mbps >= 1_000_000) return `${trim(mbps / 1_000_000)}T`;
  if (mbps >= 1000) return `${trim(mbps / 1000)}G`;
  return `${trim(mbps)}M`;
}

function trim(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** The whole capability, shortest first: `1G/2.5G`. The top speed alone is `formatSpeed(max)`. */
export function formatSpeeds(speeds: number[]): string {
  return speeds.map(formatSpeed).join("/");
}

/** Copper or fibre, from whatever was said: the medium itself, the connector, or the speed name. */
export function mediumFrom(medium: unknown, connector: unknown, speeds: unknown): PortMedium | null {
  const stated = String(medium ?? "").trim().toLowerCase();
  if (/^(copper|electrical|rj-?45|twisted|utp|stp|dac|cat\d)/.test(stated)) return "copper";
  if (/^(fibre|fiber|optical|optic|sfp|lc|sc|mpo|glass)/.test(stated)) return "fibre";

  const plug = String(connector ?? "").trim().toLowerCase();
  if (plug) {
    const known = CONNECTOR_MEDIUM[plug.replace(/\s+/g, "")];
    if (known) return known;
    // An SFP cage is a socket, not a medium: it takes an optical transceiver or a copper DAC. It is
    // read as fibre because that is what one almost always holds, and it can be said outright.
    if (/^(sfp|qsfp|xfp|gbic|osfp)/.test(plug)) return "fibre";
    if (/^(rj|base-?t|eth)/.test(plug)) return "copper";
  }

  const names = (Array.isArray(speeds) ? speeds : [speeds]).map((s) => String(s ?? "")).join(" ");
  if (BASE_COPPER.test(names)) return "copper";
  if (BASE_FIBRE.test(names)) return "fibre";
  return null;
}

/** `1-8`, `1,3,5`, `9-11, 12`, or a single port. Out-of-order and overlapping ranges are fine. */
export function parsePortList(value: unknown): number[] {
  const text = (Array.isArray(value) ? value : [value]).filter((v) => v !== null && v !== undefined && v !== "").join(",");
  const ports = new Set<number>();
  for (const part of text.split(/[,;]/)) {
    const span = /^\s*(\d+)\s*[-–]\s*(\d+)\s*$/.exec(part);
    if (span) {
      const from = Number(span[1]);
      const to = Number(span[2]);
      const [lo, hi] = from <= to ? [from, to] : [to, from];
      // A typo like `1-9999` should not allocate a million ports.
      for (let p = lo; p <= Math.min(hi, lo + 4096); p++) ports.add(p);
      continue;
    }
    const one = /^\s*(\d+)\s*$/.exec(part);
    if (one) ports.add(Number(one[1]));
  }
  return [...ports].sort((a, b) => a - b);
}

export function formatPortList(ports: number[]): string {
  const sorted = [...new Set(ports)].sort((a, b) => a - b);
  const runs: string[] = [];
  let start: number | null = null;
  let previous: number | null = null;
  const flush = (): void => {
    if (start === null || previous === null) return;
    runs.push(start === previous ? String(start) : `${start}-${previous}`);
  };
  for (const port of sorted) {
    if (start === null) start = port;
    else if (previous !== null && port !== previous + 1) {
      flush();
      start = port;
    }
    previous = port;
  }
  flush();
  return runs.join(",");
}

export interface ResolvedPort {
  port: number;
  medium: PortMedium | null;
  connector: string | null;
  /** Ascending, in Mbit/s. */
  speeds: number[];
  maxSpeed: number | null;
  poe: boolean;
  mode: "access" | "trunk" | null;
  vlan: number | null;
  allowed: number[];
  label: string | null;
}

/**
 * Everything known about one port: its hardware group, then its own configuration on top.
 *
 * Configuration wins, because it is the more specific statement — a group says "ports 9–11 are
 * 2.5G copper" and a per-port entry saying otherwise is someone recording the exception.
 */
export function resolvePort(device: Device, port: number): ResolvedPort {
  const group: PortGroup | undefined = device.portGroups.find((g) => g.ports.includes(port));
  const config: PortConfig | undefined = device.portConfig.find((c) => c.port === port);

  const speeds = config?.speeds.length ? config.speeds : group?.speeds ?? [];
  const connector = config?.connector ?? group?.connector ?? null;
  const medium = config?.medium ?? group?.medium ?? mediumFrom(null, connector, null);
  return {
    port,
    medium,
    connector,
    speeds,
    maxSpeed: speeds.length ? speeds[speeds.length - 1] : null,
    poe: device.poePorts.includes(port) || group?.poe === true,
    mode: config?.mode ?? null,
    vlan: config?.vlan ?? null,
    allowed: config?.allowed ?? [],
    label: config?.label ?? group?.label ?? null,
  };
}

/** Every port a device is known to have, whether from its count or from what its groups mention. */
export function portNumbers(device: Device): number[] {
  const highest = Math.max(
    device.ports ?? 0,
    ...device.portGroups.flatMap((g) => g.ports),
    ...device.portConfig.map((c) => c.port),
    0
  );
  const ports: number[] = [];
  for (let p = 1; p <= highest; p++) ports.push(p);
  return ports;
}

export interface PortTally {
  count: number;
  medium: PortMedium | null;
  speeds: number[];
  connector: string | null;
  poe: boolean;
}

/**
 * The port inventory as a person would say it: "8 × 1G copper · 3 × 2.5G copper · 1 × 10G SFP+".
 * Ports nothing is known about are tallied together at the end rather than pretended about.
 */
export function portTallies(device: Device): PortTally[] {
  const groups = new Map<string, PortTally>();
  for (const port of portNumbers(device)) {
    const resolved = resolvePort(device, port);
    const key = `${resolved.medium ?? "?"}|${resolved.speeds.join(",")}|${resolved.connector ?? ""}|${resolved.poe}`;
    const existing = groups.get(key);
    if (existing) existing.count++;
    else groups.set(key, { count: 1, medium: resolved.medium, speeds: resolved.speeds, connector: resolved.connector, poe: resolved.poe });
  }
  // Fastest and best-described first; the unknowns fall to the end.
  return [...groups.values()].sort((a, b) => (b.speeds[b.speeds.length - 1] ?? -1) - (a.speeds[a.speeds.length - 1] ?? -1));
}

export function describeTally(tally: PortTally): string {
  const bits = [
    tally.speeds.length ? formatSpeeds(tally.speeds) : "speed not recorded",
    tally.connector ?? tally.medium ?? null,
    tally.poe ? "PoE" : null,
  ].filter(Boolean);
  return `${tally.count} × ${bits.join(" ")}`;
}

/** The BASE-T ladder. A copper port that does one of these negotiates the ones below it too. */
const COPPER_LADDER = [100, 1000, 2500, 5000, 10000];

/**
 * What a port can *actually* negotiate, as opposed to the headline figure written on it.
 *
 * Copper Ethernet falls back: a 2.5GBASE-T port also does 1G and 100M, which is why "2.5G" on one
 * end and "1G" on the other is an ordinary gigabit link and not an incompatibility. Optics do not
 * work that way — a 10G SFP+ module generally will not talk to a 1G one — so a fibre port is taken
 * at exactly its word, and so is a port whose medium nobody recorded.
 *
 * Only used for deciding what a link does. What gets *displayed* is what the note actually says.
 */
export function effectiveSpeeds(port: ResolvedPort): number[] {
  if (port.medium !== "copper" || port.maxSpeed === null) return port.speeds;
  return [...new Set([...port.speeds, ...COPPER_LADDER.filter((s) => s <= (port.maxSpeed as number))])].sort((a, b) => a - b);
}

export type LinkVerdict =
  | { ok: true; speed: number | null; limitedBy: "near" | "far" | null }
  | { ok: false; reason: "medium" | "speed" };

/**
 * Can these two ports be cabled together, and at what speed?
 *
 * The answer is the fastest speed **both** ends support — not the faster end's headline figure,
 * which is the number people quote and then wonder about. Different media is a hard no: fibre does
 * not go into RJ45 without something in between.
 */
export function linkVerdict(near: ResolvedPort, far: ResolvedPort): LinkVerdict {
  if (near.medium && far.medium && near.medium !== far.medium) return { ok: false, reason: "medium" };
  if (near.speeds.length === 0 || far.speeds.length === 0) return { ok: true, speed: null, limitedBy: null };
  const nearSpeeds = effectiveSpeeds(near);
  const farSpeeds = effectiveSpeeds(far);
  const shared = nearSpeeds.filter((s) => farSpeeds.includes(s));
  if (shared.length === 0) return { ok: false, reason: "speed" };
  const speed = shared[shared.length - 1];
  const nearMax = near.maxSpeed ?? 0;
  const farMax = far.maxSpeed ?? 0;
  const limitedBy = speed < nearMax && farMax <= speed ? "far" : speed < farMax && nearMax <= speed ? "near" : null;
  return { ok: true, speed, limitedBy };
}

// ── Editing ──────────────────────────────────────────────────────────────────
//
// The view edits ports through these rather than by rewriting frontmatter itself, so that "set
// ports 9–11 to 2.5G" behaves the same however many groups those ports were previously spread
// across, and repeated edits do not shred one tidy group into eleven.

export interface PortHardware {
  medium: PortMedium | null;
  connector: string | null;
  speeds: number[];
  poe: boolean | null;
  label: string | null;
}

const EMPTY_HARDWARE = (h: PortHardware): boolean =>
  h.medium === null && h.connector === null && h.speeds.length === 0 && h.poe === null && h.label === null;

const sameHardware = (a: PortGroup | PortHardware, b: PortGroup | PortHardware): boolean =>
  a.medium === b.medium &&
  (a.connector ?? null) === (b.connector ?? null) &&
  a.speeds.join(",") === b.speeds.join(",") &&
  (a.poe ?? null) === (b.poe ?? null) &&
  (a.label ?? null) === (b.label ?? null);

/**
 * Sets the hardware of some ports, taking them out of whatever group they were in.
 *
 * Groups that end up identical are merged and empty ones dropped, so editing the same ports twice
 * leaves one group rather than a trail of them. Passing hardware with nothing set clears those
 * ports instead.
 */
export function applyPortHardware(groups: PortGroup[], ports: number[], hardware: PortHardware): PortGroup[] {
  const touched = new Set(ports);
  const kept: PortGroup[] = groups
    .map((g) => ({ ...g, ports: g.ports.filter((p) => !touched.has(p)) }))
    .filter((g) => g.ports.length > 0);

  if (!EMPTY_HARDWARE(hardware) && ports.length > 0) {
    kept.push({ ports: [...touched].sort((a, b) => a - b), ...hardware });
  }

  const merged: PortGroup[] = [];
  for (const group of kept) {
    const twin = merged.find((m) => sameHardware(m, group));
    if (twin) twin.ports = [...new Set([...twin.ports, ...group.ports])].sort((a, b) => a - b);
    else merged.push({ ...group, ports: [...group.ports].sort((a, b) => a - b) });
  }
  return merged.sort((a, b) => a.ports[0] - b.ports[0]);
}

export interface PortSetup {
  mode: "access" | "trunk" | null;
  vlan: number | null;
  allowed: number[];
  label: string | null;
}

/** Sets the configuration of some ports, one entry each. Nothing set removes their entries. */
export function applyPortConfig(configs: PortConfig[], ports: number[], setup: PortSetup): PortConfig[] {
  const touched = new Set(ports);
  const kept = configs.filter((c) => !touched.has(c.port));
  const empty = setup.mode === null && setup.vlan === null && setup.allowed.length === 0 && setup.label === null;
  if (!empty) {
    for (const port of touched) {
      const previous = configs.find((c) => c.port === port);
      kept.push({
        port,
        mode: setup.mode ?? "access",
        vlan: setup.vlan,
        allowed: setup.allowed,
        label: setup.label,
        // Hardware overrides on this port are none of this function's business.
        medium: previous?.medium ?? null,
        connector: previous?.connector ?? null,
        speeds: previous?.speeds ?? [],
      });
    }
  }
  return kept.sort((a, b) => a.port - b.port);
}

/** Back to frontmatter: ranges collapsed, speeds as people write them, nothing empty written. */
export function portGroupsToFrontmatter(groups: PortGroup[]): Record<string, unknown>[] {
  return groups.map((g) => {
    const out: Record<string, unknown> = { ports: formatPortList(g.ports) };
    if (g.speeds.length) out.speeds = formatSpeeds(g.speeds);
    if (g.medium) out.medium = g.medium;
    if (g.connector) out.connector = g.connector;
    if (g.poe !== null) out.poe = g.poe;
    if (g.label) out.label = g.label;
    return out;
  });
}

export function portConfigToFrontmatter(configs: PortConfig[]): Record<string, unknown>[] {
  return configs.map((c) => {
    const out: Record<string, unknown> = { port: c.port, mode: c.mode };
    if (c.vlan !== null) out.vlan = c.vlan;
    if (c.allowed.length) out.allowed = c.allowed;
    if (c.label) out.label = c.label;
    if (c.medium) out.medium = c.medium;
    if (c.connector) out.connector = c.connector;
    if (c.speeds.length) out.speeds = formatSpeeds(c.speeds);
    return out;
  });
}

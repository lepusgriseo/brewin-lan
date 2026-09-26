// Frontmatter → model. No Obsidian imports: the store hands over a plain object and this decides
// what it means, so every awkward real-world spelling can be tested without a vault.
//
// The governing rule is tolerance. These notes are written by hand and predate the plugin —
// RasPutin's address field is a list of prose lines like
// `192.168.0.51 /24 (wlan0, LAN, static — router direct, was 192.168.5.116 …)`. Refusing to read
// that would mean rewriting the user's notes to suit the code, which is backwards. Anything not
// understood is kept in `note` rather than dropped.

import { DeviceType, normaliseTypeId } from "./deviceTypes";
import { isIpv6, normaliseMac, parseAddress, parseCidr, parseRange } from "./ip";
import { mediumFrom, parsePortList, parseSpeeds } from "./ports";
import { Assignment, Device, DeviceStatus, Iface, IpRange, PortConfig, PortGroup, Segment } from "./types";

type Fm = Record<string, unknown>;

/** Frontmatter keys are matched case- and separator-insensitively: `dhcp_range`, `DHCP Range`. */
function fold(key: string): string {
  return key.toLowerCase().replace(/[\s_-]+/g, "");
}

export function pick(fm: Fm, ...keys: string[]): unknown {
  const wanted = keys.map(fold);
  for (const [k, v] of Object.entries(fm)) {
    if (wanted.includes(fold(k)) && v !== null && v !== undefined && v !== "") return v;
  }
  return undefined;
}

function asList(value: unknown): unknown[] {
  if (value === undefined || value === null || value === "") return [];
  return Array.isArray(value) ? value.filter((v) => v !== null && v !== undefined && v !== "") : [value];
}

function asString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

function asNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  // `vlan: "[[VLAN 20 — IoT]]"` is a link, not a number; take the first integer in it.
  const digits = /-?\d+/.exec(String(value));
  if (!digits) return null;
  const n = Number(digits[0]);
  return Number.isFinite(n) ? n : null;
}

/** `[[04_Areas/Network/Devices/Sky Router|Sky Router]]` → `Sky Router`. Plain text passes through. */
export function linkText(value: unknown): string | null {
  const raw = asString(value);
  if (raw === null) return null;
  const inner = /^\[\[(.+?)\]\]$/.exec(raw);
  const body = inner ? inner[1] : raw;
  const noAlias = body.split("|")[0].split("#")[0];
  const base = noAlias.split("/").pop() ?? noAlias;
  return base.replace(/\.md$/i, "").trim() || null;
}

const IFACE_NAME = /\b(eth\d+|en[a-z0-9]+|wlan\d+|wl[a-z0-9]+|wg\d+|br\d+|bond\d+|vlan\d+|lo|tun\d+|tap\d+|usb\d+)\b/i;
const ASSIGNMENTS: Record<string, Assignment> = { static: "static", dhcp: "dhcp", reserved: "reserved", fixed: "static", manual: "static" };

function assignmentIn(text: string): Assignment {
  const found = text.toLowerCase().match(/\b(static|dhcp|reserved|fixed|manual)\b/);
  return found ? ASSIGNMENTS[found[1]] : "unknown";
}

function vlanIn(text: string): number | null {
  const tagged = /\bvlan\s*[:#]?\s*(\d{1,4})\b/i.exec(text);
  return tagged ? Number(tagged[1]) : null;
}

/**
 * One address line, however it was written. Handles the structured form (`ip:` plus siblings),
 * the prose form, and the mapping form inside an `interfaces:` list.
 */
export function parseIfaceEntry(entry: unknown, fallbackName: string): Iface | null {
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const fm = entry as Fm;
    const addr = asString(pick(fm, "ip", "address", "addr"));
    const parsed = addr ? parseAddress(addr) : null;
    return {
      name: asString(pick(fm, "name", "interface", "iface", "if")) ?? fallbackName,
      ip: parsed?.ip ?? null,
      prefix: parsed?.prefix ?? asNumber(pick(fm, "prefix", "cidr")) ?? null,
      vlan: asNumber(pick(fm, "vlan", "vid")),
      mac: normaliseMac(asString(pick(fm, "mac", "hwaddr")) ?? ""),
      assign: (asString(pick(fm, "assign", "assignment", "mode")) ?? "").toLowerCase() in ASSIGNMENTS
        ? ASSIGNMENTS[(asString(pick(fm, "assign", "assignment", "mode")) ?? "").toLowerCase()]
        : "unknown",
      note: asString(pick(fm, "note", "comment")) ?? "",
    };
  }

  const text = asString(entry);
  if (text === null) return null;
  if (isIpv6(text)) return null; // recorded elsewhere; never fed to the address maths
  const parsed = parseAddress(text);
  if (!parsed) return null;

  // Everything the address itself didn't claim is prose: keep it, and mine it for the three
  // things that are worth acting on — which interface, how it was assigned, which VLAN.
  const remainder = text.replace(/^\s*\d{1,3}(\.\d{1,3}){3}\s*(\/\s*\d{1,2})?/, "").trim();
  const name = IFACE_NAME.exec(text)?.[1]?.toLowerCase() ?? fallbackName;
  return {
    name,
    ip: parsed.ip,
    prefix: parsed.prefix,
    vlan: vlanIn(text),
    mac: null,
    assign: assignmentIn(text),
    note: remainder.replace(/^[\s(,—–-]+|[\s),]+$/g, ""),
  };
}

/** `managed: true`, `managed: unmanaged`, `managed: web-smart` — all of which people write. */
function managedFrom(value: unknown): boolean | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (/^(un|non)[- ]?managed$|^dumb$|^no$|^false$/.test(text)) return false;
  if (/managed|smart|cli|web|snmp|^yes$|^true$/.test(text)) return true;
  return null;
}

const STATUSES: DeviceStatus[] = ["active", "planned", "offline", "retired"];

function statusOf(raw: string | null): DeviceStatus {
  const text = (raw ?? "").trim().toLowerCase();
  if (STATUSES.includes(text as DeviceStatus)) return text as DeviceStatus;
  // The vault's existing device notes say things like "Active" or "In Progress".
  if (/(^|\b)(up|online|live|in use)\b/.test(text)) return "active";
  if (/(^|\b)(plan|todo|ordered|wanted|in progress)/.test(text)) return "planned";
  if (/(^|\b)(down|off|unplugged)/.test(text)) return "offline";
  if (/(^|\b)(retired|sold|dead|decommission)/.test(text)) return "retired";
  return "active";
}

/** A DNS label from the note title: lower case, spaces to hyphens, nothing exotic left. */
export function hostnameFrom(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63) || "device"
  );
}

function portConfigFrom(value: unknown): PortConfig[] {
  const out: PortConfig[] = [];
  for (const entry of asList(value)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const fm = entry as Fm;
    const port = asNumber(pick(fm, "port", "interface", "no"));
    if (port === null) continue;
    const mode = (asString(pick(fm, "mode", "type")) ?? "access").toLowerCase() === "trunk" ? "trunk" : "access";
    const connector = asString(pick(fm, "connector", "socket", "form", "cage"));
    const speeds = parseSpeeds(pick(fm, "speeds", "speed", "rates"));
    out.push({
      port,
      mode,
      vlan: asNumber(pick(fm, "vlan", "nativevlan", "accessvlan", "vid")),
      allowed: asList(pick(fm, "allowed", "allowedvlans", "tagged")).map((v) => asNumber(v)).filter((n): n is number => n !== null),
      label: asString(pick(fm, "label", "note", "description")),
      medium: mediumFrom(pick(fm, "medium", "presentation", "physical"), connector, pick(fm, "speeds", "speed")),
      connector,
      speeds,
    });
  }
  return out.sort((a, b) => a.port - b.port);
}

/** The hardware blocks: one entry per range of identical ports. */
function portGroupsFrom(value: unknown): PortGroup[] {
  const out: PortGroup[] = [];
  for (const entry of asList(value)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const fm = entry as Fm;
    const ports = parsePortList(pick(fm, "ports", "port", "range"));
    if (ports.length === 0) continue;
    const connector = asString(pick(fm, "connector", "socket", "form", "cage"));
    const poe = pick(fm, "poe", "poweroverethernet");
    out.push({
      ports,
      medium: mediumFrom(pick(fm, "medium", "presentation", "physical"), connector, pick(fm, "speeds", "speed")),
      connector,
      speeds: parseSpeeds(pick(fm, "speeds", "speed", "rates")),
      poe: poe === undefined ? null : !/^(false|no|0|none)$/i.test(String(poe)),
      label: asString(pick(fm, "label", "note", "description")),
    });
  }
  return out;
}

export interface NoteInput {
  path: string;
  basename: string;
  frontmatter: Fm;
  mtime: number;
}

export function deviceFromNote(note: NoteInput, types: DeviceType[]): Device {
  const fm = note.frontmatter;
  const title = asString(pick(fm, "name", "device name")) ?? note.basename;

  // Interfaces come from an explicit list when there is one, and otherwise from the flat fields.
  // Both may be present: a device with `ip:` for its main address and `interfaces:` for the rest.
  const ifaces: Iface[] = [];
  const flatIp = pick(fm, "ip", "ipv4", "address");
  const flatMac = normaliseMac(asString(pick(fm, "mac", "hwaddr", "macaddress")) ?? "");
  const flatVlan = asNumber(pick(fm, "vlan", "vid"));
  const flatAssign = (asString(pick(fm, "assign", "assignment")) ?? "").toLowerCase();

  for (const entry of asList(flatIp)) {
    const iface = parseIfaceEntry(entry, "primary");
    if (iface) ifaces.push(iface);
  }
  for (const entry of asList(pick(fm, "interfaces", "nics", "ports list"))) {
    const iface = parseIfaceEntry(entry, `if${ifaces.length}`);
    if (iface) ifaces.push(iface);
  }

  // Flat `mac:`/`vlan:` belong to the first address unless that address brought its own.
  if (ifaces.length > 0) {
    if (flatMac && !ifaces[0].mac) ifaces[0].mac = flatMac;
    if (flatVlan !== null && ifaces[0].vlan === null) ifaces[0].vlan = flatVlan;
    if (ifaces[0].assign === "unknown" && flatAssign in ASSIGNMENTS) ifaces[0].assign = ASSIGNMENTS[flatAssign];
  } else if (flatMac || flatVlan !== null) {
    // A device known only by MAC — a DHCP client you want a reservation for — is still a device.
    ifaces.push({ name: "primary", ip: null, prefix: null, vlan: flatVlan, mac: flatMac, assign: flatAssign in ASSIGNMENTS ? ASSIGNMENTS[flatAssign] : "unknown", note: "" });
  }

  const rawType = asString(pick(fm, "device", "device type", "devicetype", "kind", "role"));
  return {
    path: note.path,
    title,
    hostname: asString(pick(fm, "hostname", "host")) ?? hostnameFrom(title),
    type: rawType ? normaliseTypeId(rawType, types) : "other",
    status: statusOf(asString(pick(fm, "status", "state"))),
    location: asString(pick(fm, "location", "room", "site")),
    ifaces,
    uplink: linkText(pick(fm, "uplink", "connectedto", "parent", "upstream")),
    uplinkPort: asNumber(pick(fm, "uplink port", "uplinkport", "remote port", "port on uplink", "parentport", "far port")),
    localPort: asNumber(pick(fm, "local port", "localport", "own port", "this port", "near port", "uplink local port")),
    managed: managedFrom(pick(fm, "managed", "management", "managed?")),
    ports: asNumber(pick(fm, "ports", "port count", "portcount")),
    poePorts: asList(pick(fm, "poe ports", "poeports", "poe")).map((v) => asNumber(v)).filter((n): n is number => n !== null),
    portGroups: portGroupsFrom(pick(fm, "port groups", "portgroups", "port hardware", "porttypes", "port types")),
    portConfig: portConfigFrom(pick(fm, "port config", "portconfig", "port map", "portmap")),
    services: asList(pick(fm, "services", "service")).map((v) => linkText(v)).filter((s): s is string => s !== null),
    ipv6: asList(pick(fm, "ipv6", "ip6")).map((v) => asString(v)).filter((s): s is string => s !== null),
    notes: asString(pick(fm, "purpose", "notes", "description")),
    mtime: note.mtime,
  };
}

function rangesFrom(value: unknown): IpRange[] {
  return asList(value)
    .map((v) => parseRange(String(v)))
    .filter((r): r is IpRange => r !== null);
}

export function segmentFromNote(note: NoteInput): Segment {
  const fm = note.frontmatter;
  const cidrText = asString(pick(fm, "cidr", "subnet", "network", "prefix")) ?? "";
  const poolText = asString(pick(fm, "dhcp range", "dhcprange", "pool", "dhcp", "dhcppool")) ?? "";
  return {
    path: note.path,
    title: asString(pick(fm, "name", "label")) ?? note.basename,
    vlanId: asNumber(pick(fm, "vlan", "vlanid", "vid")),
    cidr: cidrText ? parseCidr(cidrText) : null,
    cidrText,
    gateway: (() => {
      const g = asString(pick(fm, "gateway", "gw", "router"));
      return g ? parseAddress(g)?.ip ?? null : null;
    })(),
    pool: poolText ? parseRange(poolText) : null,
    poolText,
    reserved: rangesFrom(pick(fm, "reserved", "reservedrange", "excluded")),
    colour: asString(pick(fm, "colour", "color")),
    purpose: asString(pick(fm, "purpose", "description", "notes")),
  };
}

/** Does this note's `tags:` (plus any inline tags the cache found) carry the marker tag? */
export function hasTag(tags: string[], marker: string): boolean {
  const want = marker.replace(/^#/, "").toLowerCase();
  return tags.some((t) => {
    const tag = t.replace(/^#/, "").toLowerCase();
    // A nested tag counts for its parent: `Network/Device/Static` is still a device.
    return tag === want || tag.startsWith(want + "/");
  });
}

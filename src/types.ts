// Pure data model — no Obsidian imports, so everything here stays unit-testable.
//
// The vault is the source of truth: a device is a note, a segment (VLAN or plain subnet) is a
// note, and this file describes what the parser makes of their frontmatter. Nothing in the plugin
// keeps its own copy of the network.

/** How an address was come by, which decides whether it belongs in a DHCP pool or outside one. */
export type Assignment = "static" | "dhcp" | "reserved" | "unknown";

export type DeviceStatus = "active" | "planned" | "offline" | "retired";

/** One address on one interface. A device may have several — RasPutin has wlan0, eth0 and wg0. */
export interface Iface {
  /** `wlan0`, `eth0`, `wg0`, or `primary` when the note only said `ip:`. */
  name: string;
  /** Dotted quad, or null for an interface that exists but has no address recorded. */
  ip: string | null;
  /** Prefix length, when the note gave one. */
  prefix: number | null;
  /** An explicit VLAN tag on this interface, overriding whatever the address implies. */
  vlan: number | null;
  mac: string | null;
  assign: Assignment;
  /** Whatever prose came with a legacy `IP:` entry, kept so nothing is silently dropped. */
  note: string;
}

/** A port as the switch note configures it. Occupancy is never stored here — it is derived from
 *  which devices say they uplink to this port, so there is only ever one place to edit. */
export interface PortConfig {
  port: number;
  mode: "access" | "trunk";
  /** Access VLAN, or a trunk's native VLAN. */
  vlan: number | null;
  /** Trunk only. Empty means "all". */
  allowed: number[];
  label: string | null;
}

export interface Device {
  path: string;
  /** Note basename. */
  title: string;
  /** DNS/DHCP name — `hostname:` if given, else the title folded to a legal label. */
  hostname: string;
  /** Device-type id, e.g. `router`, `switch`, `server`. Unknown ids fall back to `other`. */
  type: string;
  status: DeviceStatus;
  location: string | null;
  ifaces: Iface[];
  /** Raw link text of the device this one plugs into — resolved against titles later. */
  uplink: string | null;
  /**
   * The **far** end of that link: which port on the uplink device.
   *
   * Two ports are recorded because a link has two ends, and a switch-to-switch link needs both to
   * be traceable — knowing a cable lands on SW1's port 24 does not tell you which of SW2's own
   * ports it left from, and that port is occupied on SW2 either way.
   */
  uplinkPort: number | null;
  /** The **near** end: which port on *this* device the link uses. */
  localPort: number | null;
  /**
   * Managed, unmanaged, or not recorded. Null is deliberately distinct from `false`: "nobody has
   * said" must not be read as "it cannot do VLANs", or the health check invents faults.
   */
  managed: boolean | null;
  /** Port count, for anything other devices can plug into. */
  ports: number | null;
  poePorts: number[];
  portConfig: PortConfig[];
  /** Link text of services running on it, for the profile panel. */
  services: string[];
  /** IPv6 addresses are recorded and displayed but deliberately not used for maths. */
  ipv6: string[];
  notes: string | null;
  mtime: number;
}

export interface IpRange {
  /** Inclusive, as unsigned 32-bit integers. */
  start: number;
  end: number;
}

export interface Cidr {
  /** Network address as an unsigned 32-bit integer. */
  network: number;
  prefix: number;
}

/**
 * A broadcast domain: a tagged VLAN, or — the state of most home networks, including this one —
 * an untagged subnet with no VLAN id at all. Keeping `vlanId` optional is what lets the plugin
 * describe the network as it is today and the segmentation being planned in the same model.
 */
export interface Segment {
  /** Null for a segment synthesised from settings rather than read from a note. */
  path: string | null;
  title: string;
  vlanId: number | null;
  cidr: Cidr | null;
  /** As written, for display and for error messages. */
  cidrText: string;
  gateway: string | null;
  /** DHCP pool, when the segment note declares one. */
  pool: IpRange | null;
  poolText: string;
  /** Ranges held back from automatic assignment (infrastructure, printers, …). */
  reserved: IpRange[];
  /** CSS colour or a palette slot name from the note; null means "take the next palette slot". */
  colour: string | null;
  purpose: string | null;
}

export type Severity = "error" | "warn" | "info";

export interface Issue {
  code: string;
  severity: Severity;
  message: string;
  /** The note to open to fix it, when there is one. */
  path: string | null;
  /** A second note involved, for conflicts. */
  otherPath?: string | null;
}

// The device taxonomy: what a thing is, which icon stands for it, and whether other things can
// plug into it. No colours here — colour is spent on the VLAN, because a device's segment is the
// thing worth reading off a diagram at a glance, and encoding two variables in one channel makes
// both unreadable.

export interface DeviceType {
  id: string;
  label: string;
  /** Lucide icon name, drawn with Obsidian's `setIcon`. */
  icon: string;
  /** True when other devices can uplink into it — i.e. it has ports and belongs in the spine. */
  hosts: boolean;
  /** Suggested port count when creating one, for the switch-shaped types. */
  defaultPorts?: number;
}

/**
 * Ships with the plugin; editable in settings. Ordered roughly from the edge of the network
 * inwards, which is also the order the topology legend reads in.
 */
export const DEFAULT_DEVICE_TYPES: DeviceType[] = [
  { id: "router", label: "Router / gateway", icon: "router", hosts: true, defaultPorts: 4 },
  { id: "firewall", label: "Firewall", icon: "shield", hosts: true, defaultPorts: 4 },
  { id: "switch", label: "Switch", icon: "network", hosts: true, defaultPorts: 8 },
  { id: "ap", label: "Access point", icon: "wifi", hosts: true },
  { id: "extender", label: "Extender / repeater", icon: "signal", hosts: true },
  { id: "server", label: "Server", icon: "server", hosts: false },
  { id: "nas", label: "NAS / storage", icon: "hard-drive", hosts: false },
  { id: "sbc", label: "Single-board computer", icon: "cpu", hosts: false },
  { id: "vm", label: "VM / container", icon: "box", hosts: false },
  { id: "desktop", label: "Desktop", icon: "monitor", hosts: false },
  { id: "laptop", label: "Laptop", icon: "laptop", hosts: false },
  { id: "phone", label: "Phone", icon: "smartphone", hosts: false },
  { id: "tablet", label: "Tablet", icon: "tablet", hosts: false },
  { id: "tv", label: "TV / media", icon: "tv", hosts: false },
  { id: "console", label: "Games console", icon: "gamepad-2", hosts: false },
  { id: "printer", label: "Printer", icon: "printer", hosts: false },
  { id: "camera", label: "Camera", icon: "video", hosts: false },
  { id: "iot", label: "IoT / smart home", icon: "lightbulb", hosts: false },
  { id: "other", label: "Other", icon: "circle-dot", hosts: false },
];

/** The fallback type — every device resolves to something, so nothing ever fails to draw. */
export const FALLBACK_TYPE = "other";

export function findType(id: string, types: DeviceType[]): DeviceType {
  return types.find((t) => t.id === id) ?? types.find((t) => t.id === FALLBACK_TYPE) ?? { id, label: id, icon: "circle-dot", hosts: false };
}

export function typeIcon(id: string, types: DeviceType[]): string {
  return findType(id, types).icon || "circle-dot";
}

export function typeLabel(id: string, types: DeviceType[]): string {
  return findType(id, types).label || id;
}

/** Can other devices plug into this one? Decides who forms the spine of the topology. */
export function hostsOthers(id: string, types: DeviceType[]): boolean {
  return findType(id, types).hosts;
}

/**
 * Folds a written type onto a known id: `Switch`, `switches`, `managed switch` → `switch`.
 * Anything unrecognised keeps its own id rather than being silently relabelled `other`, so a
 * typo shows up in the health panel as an unknown type instead of disappearing.
 */
export function normaliseTypeId(raw: string, types: DeviceType[]): string {
  const text = raw.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (!text) return FALLBACK_TYPE;
  const exact = types.find((t) => t.id === text);
  if (exact) return exact.id;
  const singular = text.replace(/e?s$/, "");
  const bySingular = types.find((t) => t.id === singular);
  if (bySingular) return bySingular.id;
  const byLabel = types.find((t) => t.label.toLowerCase() === raw.trim().toLowerCase());
  if (byLabel) return byLabel.id;
  // A compound description usually ends in the noun: "managed switch", "wifi access point".
  const byWord = types.find((t) => text.endsWith("-" + t.id) || text.split("-").includes(t.id));
  return byWord ? byWord.id : text;
}

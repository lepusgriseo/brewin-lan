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
  /**
   * Other spellings that mean this type. Notes written before a type was renamed keep resolving —
   * a plain `device: switch` is an L2 switch, which is what anyone writing it meant.
   */
  aliases?: string[];
  /** Whether "managed or unmanaged" is a meaningful question for this type. */
  manageable?: boolean;
}

/**
 * Ships with the plugin; editable in settings. Ordered roughly from the edge of the network
 * inwards, which is also the order the topology legend reads in.
 */
export const DEFAULT_DEVICE_TYPES: DeviceType[] = [
  { id: "router", label: "Router / gateway", icon: "router", hosts: true, defaultPorts: 4, aliases: ["gateway", "broadband-router", "edge-router"] },
  { id: "firewall", label: "Firewall", icon: "shield", hosts: true, defaultPorts: 4, aliases: ["fw", "security-appliance"] },
  {
    id: "l2-switch",
    label: "L2 switch",
    icon: "network",
    hosts: true,
    defaultPorts: 8,
    manageable: true,
    aliases: ["switch", "switches", "l2", "l2switch", "layer2switch", "layer-2-switch", "access-switch", "ethernet-switch"],
  },
  {
    id: "l3-switch",
    label: "L3 switch",
    icon: "route",
    hosts: true,
    defaultPorts: 24,
    manageable: true,
    aliases: ["l3", "l3switch", "layer3switch", "layer-3-switch", "multilayer-switch", "multilayerswitch", "routing-switch", "core-switch"],
  },
  { id: "ap", label: "Access point", icon: "wifi", hosts: true, aliases: ["access-point", "accesspoint", "wap", "wireless-access-point"] },
  { id: "extender", label: "Extender / repeater", icon: "signal", hosts: true, aliases: ["repeater", "range-extender", "mesh-node", "powerline"] },
  { id: "server", label: "Server", icon: "server", hosts: false, aliases: ["host", "hypervisor"] },
  { id: "nas", label: "NAS / storage", icon: "hard-drive", hosts: false, aliases: ["storage", "file-server"] },
  { id: "sbc", label: "Single-board computer", icon: "cpu", hosts: false, aliases: ["raspberry-pi", "rpi", "pi", "single-board-computer"] },
  { id: "vm", label: "VM / container", icon: "box", hosts: false, aliases: ["virtual-machine", "container", "lxc", "docker"] },
  { id: "desktop", label: "Desktop", icon: "monitor", hosts: false, aliases: ["pc", "workstation"] },
  { id: "laptop", label: "Laptop", icon: "laptop", hosts: false, aliases: ["notebook", "macbook"] },
  { id: "phone", label: "Phone", icon: "smartphone", hosts: false, aliases: ["mobile", "smartphone", "iphone"] },
  { id: "tablet", label: "Tablet", icon: "tablet", hosts: false },
  { id: "tv", label: "TV / media", icon: "tv", hosts: false, aliases: ["television", "media-player", "set-top-box", "streamer"] },
  { id: "console", label: "Games console", icon: "gamepad-2", hosts: false },
  { id: "printer", label: "Printer", icon: "printer", hosts: false, aliases: ["mfp", "scanner", "print-server"] },
  { id: "camera", label: "Camera", icon: "video", hosts: false, aliases: ["cctv", "ip-camera", "webcam"] },
  { id: "iot", label: "IoT / smart home", icon: "lightbulb", hosts: false, aliases: ["smart-plug", "smart-home", "sensor", "thermostat", "doorbell"] },
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
 * Is "managed or unmanaged" a question worth asking of this type?
 *
 * It decides what the device can actually do: an unmanaged switch cannot tag a frame, so a VLAN
 * plan that runs through one is not a plan. Kept as a property of the device rather than a pair of
 * types, because it is one bit of information and not a different kind of thing.
 */
export function isManageable(id: string, types: DeviceType[]): boolean {
  return Boolean(findType(id, types).manageable);
}

/**
 * Folds a written type onto a known id: `Switch` and `managed switch` → `l2-switch`,
 * `Cisco L3 switch` → `l3-switch`, `Access point` → `ap`.
 *
 * A compound description usually ends in the noun, so the last word decides — except that the more
 * specific token has to win, or "cisco l3 switch" matches `switch` before it ever reaches `l3`.
 * Hence two passes, each taking the **longest** token that matched: the trailing word first, then
 * any word at all.
 *
 * Anything unrecognised keeps its own id rather than being silently relabelled `other`, so a typo
 * shows up in the health panel as an unknown type instead of disappearing.
 */
export function normaliseTypeId(raw: string, types: DeviceType[]): string {
  const text = raw.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (!text) return FALLBACK_TYPE;

  const exact = types.find((t) => t.id === text || (t.aliases ?? []).includes(text));
  if (exact) return exact.id;

  const singular = text.replace(/e?s$/, "");
  const bySingular = types.find((t) => t.id === singular || (t.aliases ?? []).includes(singular));
  if (bySingular) return bySingular.id;

  const byLabel = types.find((t) => t.label.toLowerCase() === raw.trim().toLowerCase());
  if (byLabel) return byLabel.id;

  const words = text.split("-");
  const longestMatch = (matches: (token: string) => boolean): string | null => {
    let best: { id: string; length: number } | null = null;
    for (const type of types) {
      for (const token of [type.id, ...(type.aliases ?? [])]) {
        if (matches(token) && (best === null || token.length > best.length)) best = { id: type.id, length: token.length };
      }
    }
    return best?.id ?? null;
  };

  return longestMatch((token) => text.endsWith("-" + token)) ?? longestMatch((token) => words.includes(token)) ?? text;
}

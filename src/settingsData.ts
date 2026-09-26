// Settings data and migration. Kept apart from the settings *tab* because that has to import
// Obsidian, which cannot be loaded in a unit test — and the migration is the one piece here with
// a history of going wrong.

import { DEFAULT_DEVICE_TYPES, DeviceType } from "./deviceTypes";
import { LayoutMode } from "./topology";
import { ExportFormat } from "./exports";

export interface BrewinLanSettings {
  /** Tag that marks a note as a device. A nested tag counts too. */
  deviceTag: string;
  /** Tag that marks a note as a VLAN or subnet. */
  segmentTag: string;
  /** Where "new device" writes. Notes here also count as devices if they carry an address field. */
  devicesFolder: string;
  segmentsFolder: string;
  /** The note new devices and segments point `up:` at. */
  hubNote: string;
  /** Local domain names are qualified with in the exports. */
  lanDomain: string;

  layoutMode: LayoutMode;
  nodeSpacing: number;
  levelSpacing: number;
  showInternet: boolean;
  /** Retired kit: out of the diagram and the clash checks unless this is on. */
  includeRetired: boolean;
  /** Above this many addresses the address map lists instead of drawing a grid. */
  maxGridCells: number;
  /** Remembered between openings, since it is nearly always the same one wanted. */
  lastExport: ExportFormat;

  deviceTypes: DeviceType[];
  settingsVersion: number;
}

export const SETTINGS_VERSION = 1;

export const DEFAULT_SETTINGS: BrewinLanSettings = {
  deviceTag: "Network/Device",
  segmentTag: "Network/VLAN",
  devicesFolder: "04_Areas/Network/Devices",
  segmentsFolder: "04_Areas/Network/Segments",
  hubNote: "Network",
  lanDomain: "rasputin.lan",
  layoutMode: "tree",
  nodeSpacing: 150,
  levelSpacing: 120,
  showInternet: true,
  includeRetired: false,
  maxGridCells: 1024,
  lastExport: "dnsmasq-dhcp",
  deviceTypes: DEFAULT_DEVICE_TYPES,
  settingsVersion: SETTINGS_VERSION,
};

/**
 * Merges saved settings over the defaults.
 *
 * Device types are merged **by id**, with any default the saved list is missing appended. That
 * matters because the plugin rewrites `data.json` as it runs: a saved copy of the type list would
 * otherwise shadow the code's, and a type added in a later version would never appear — exactly
 * the bug that left two Atlas categories rendering grey for weeks. Edits the user has made to a
 * type are kept, since their copy wins for ids that exist in both.
 */
export function migrateSettings(raw: unknown): BrewinLanSettings {
  const saved = (raw ?? {}) as Partial<BrewinLanSettings>;
  const settings: BrewinLanSettings = { ...DEFAULT_SETTINGS, ...saved };

  const savedTypes = Array.isArray(saved.deviceTypes) ? saved.deviceTypes.filter((t) => t && typeof t.id === "string") : [];
  const byId = new Map<string, DeviceType>();
  for (const type of savedTypes) {
    byId.set(type.id, {
      id: type.id,
      label: typeof type.label === "string" && type.label ? type.label : type.id,
      icon: typeof type.icon === "string" && type.icon ? type.icon : "circle-dot",
      hosts: Boolean(type.hosts),
      defaultPorts: typeof type.defaultPorts === "number" ? type.defaultPorts : undefined,
    });
  }
  const merged = [...byId.values()];
  for (const fallback of DEFAULT_DEVICE_TYPES) {
    if (!byId.has(fallback.id)) merged.push({ ...fallback });
  }
  settings.deviceTypes = merged.length ? merged : DEFAULT_DEVICE_TYPES.map((t) => ({ ...t }));

  // Numbers that came back as strings from a hand-edited data.json, and nonsense clamped.
  settings.nodeSpacing = clamp(Number(settings.nodeSpacing), 60, 400, DEFAULT_SETTINGS.nodeSpacing);
  settings.levelSpacing = clamp(Number(settings.levelSpacing), 60, 400, DEFAULT_SETTINGS.levelSpacing);
  settings.maxGridCells = clamp(Number(settings.maxGridCells), 64, 8192, DEFAULT_SETTINGS.maxGridCells);
  if (settings.layoutMode !== "tree" && settings.layoutMode !== "vlan") settings.layoutMode = "tree";
  settings.deviceTag = String(settings.deviceTag || DEFAULT_SETTINGS.deviceTag).replace(/^#/, "");
  settings.segmentTag = String(settings.segmentTag || DEFAULT_SETTINGS.segmentTag).replace(/^#/, "");
  settings.lanDomain = String(settings.lanDomain || DEFAULT_SETTINGS.lanDomain).replace(/^\.+|\.+$/g, "");
  settings.settingsVersion = SETTINGS_VERSION;
  return settings;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}


import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_DEVICE_TYPES } from "../src/deviceTypes";
import { DEFAULT_SETTINGS, migrateSettings, SETTINGS_VERSION } from "../src/settingsData";
import { segmentColour, SEGMENT_SLOTS } from "../src/palette";
import { segment } from "./fixtures";

test("nothing saved yet gives the shipped defaults", () => {
  const settings = migrateSettings(undefined);
  assert.equal(settings.deviceTag, "Network/Device");
  assert.equal(settings.deviceTypes.length, DEFAULT_DEVICE_TYPES.length);
  assert.equal(settings.settingsVersion, SETTINGS_VERSION);
});

test("saved values win, and unknown keys are left alone", () => {
  const settings = migrateSettings({ lanDomain: "lab.example.com", showInternet: false });
  assert.equal(settings.lanDomain, "lab.example.com");
  assert.equal(settings.showInternet, false);
  assert.equal(settings.devicesFolder, DEFAULT_SETTINGS.devicesFolder);
});

test("a device type added in a later version reaches an existing install", () => {
  // This is the bug that left two Atlas categories grey: data.json held the old list and shadowed
  // the code's. Here the saved list is short and every missing default must come back.
  const saved = { deviceTypes: [{ id: "router", label: "Router", icon: "router", hosts: true }] };
  const settings = migrateSettings(saved);
  const ids = settings.deviceTypes.map((t) => t.id);
  assert.ok(ids.includes("camera"));
  assert.ok(ids.includes("other"));
  assert.equal(new Set(ids).size, ids.length, "no duplicates");
  // The user's copy of a type they already had is the one kept.
  assert.equal(settings.deviceTypes.find((t) => t.id === "router")?.label, "Router");
  assert.equal(settings.deviceTypes[0].id, "router", "their order is preserved, new ones append");
});

test("an edited icon survives migration", () => {
  const saved = { deviceTypes: [{ id: "server", label: "Server", icon: "hard-drive", hosts: false }] };
  assert.equal(migrateSettings(saved).deviceTypes.find((t) => t.id === "server")?.icon, "hard-drive");
});

test("a custom type the code has never heard of is kept", () => {
  const saved = { deviceTypes: [{ id: "projector", label: "Projector", icon: "projector", hosts: false }] };
  const types = migrateSettings(saved).deviceTypes;
  assert.ok(types.some((t) => t.id === "projector"));
  assert.equal(types.length, DEFAULT_DEVICE_TYPES.length + 1);
});

test("a mangled type list falls back rather than breaking the plugin", () => {
  assert.equal(migrateSettings({ deviceTypes: "nonsense" }).deviceTypes.length, DEFAULT_DEVICE_TYPES.length);
  const partial = migrateSettings({ deviceTypes: [{ id: "x" }, null, { label: "no id" }] });
  assert.equal(partial.deviceTypes.find((t) => t.id === "x")?.icon, "circle-dot");
});

test("numbers from a hand-edited data.json are coerced and clamped", () => {
  const settings = migrateSettings({ nodeSpacing: "220", levelSpacing: 9999, maxGridCells: 2, layoutMode: "spiral" });
  assert.equal(settings.nodeSpacing, 220);
  assert.equal(settings.levelSpacing, 400);
  assert.equal(settings.maxGridCells, 64);
  assert.equal(settings.layoutMode, "tree");
});

test("tags lose a leading hash and the domain loses stray dots", () => {
  const settings = migrateSettings({ deviceTag: "#Net/Device", segmentTag: "#Net/VLAN", lanDomain: ".lan." });
  assert.deepEqual([settings.deviceTag, settings.segmentTag, settings.lanDomain], ["Net/Device", "Net/VLAN", "lan"]);
});

test("segment colours cycle through the slots, and a note may override", () => {
  const plain = segment("A", { name: "A", cidr: "10.0.0.0/24" });
  assert.equal(segmentColour(plain, 0), "var(--brewin-lan-seg-1)");
  assert.equal(segmentColour(plain, SEGMENT_SLOTS), "var(--brewin-lan-seg-1)", "wraps round");
  assert.equal(segmentColour(null, 3), "var(--text-muted)");
  assert.equal(segmentColour(segment("B", { name: "B", colour: "amber" }), 0), "var(--brewin-lan-seg-4)");
  assert.equal(segmentColour(segment("C", { name: "C", colour: "#ff0055" }), 0), "#ff0055");
});

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyPortConfig,
  applyPortHardware,
  describeTally,
  effectiveSpeeds,
  formatPortList,
  formatSpeed,
  formatSpeeds,
  linkVerdict,
  mediumFrom,
  parsePortList,
  parseSpeed,
  parseSpeeds,
  portConfigToFrontmatter,
  portGroupsToFrontmatter,
  portTallies,
  resolvePort,
} from "../src/ports";
import { device, TYPES } from "./fixtures";

test("a single speed token, in any of the spellings on a datasheet", () => {
  assert.equal(parseSpeed("10G"), 10000);
  assert.equal(parseSpeed("2.5GbE"), 2500);
  assert.equal(parseSpeed("100M"), 100);
  assert.equal(parseSpeed("1 Gbps"), 1000);
  assert.equal(parseSpeed("1000BASE-T"), 1000);
  assert.equal(parseSpeed("10GBASE-SR"), 10000);
  // A bare number means nothing without a unit, unless the caller supplies one.
  assert.equal(parseSpeed("1000"), null);
  assert.equal(parseSpeed("1000", 1), 1000);
  assert.equal(parseSpeed("nonsense"), null);
});

test("a list of speeds: the unit is written once, at the end", () => {
  assert.deepEqual(parseSpeeds("1/2.5/5/10G"), [1000, 2500, 5000, 10000]);
  assert.deepEqual(parseSpeeds("2.5G"), [2500]);
  assert.deepEqual(parseSpeeds(["1G", "2.5G"]), [1000, 2500]);
  // The classic notation has no unit anywhere and has always meant Mbit/s.
  assert.deepEqual(parseSpeeds("10/100/1000"), [10, 100, 1000]);
  // Fractions cannot be Mbit/s in this context, so an unqualified list of them is gigabit.
  assert.deepEqual(parseSpeeds("1/2.5"), [1000, 2500]);
  assert.deepEqual(parseSpeeds(""), []);
  assert.deepEqual(parseSpeeds(undefined), []);
  // Duplicates fold and the result is always ascending, so comparisons are cheap.
  assert.deepEqual(parseSpeeds("10G, 1G, 10G"), [1000, 10000]);
});

test("speeds format back the way people write them", () => {
  assert.equal(formatSpeed(100), "100M");
  assert.equal(formatSpeed(1000), "1G");
  assert.equal(formatSpeed(2500), "2.5G");
  assert.equal(formatSpeed(10000), "10G");
  assert.equal(formatSpeeds([1000, 2500, 10000]), "1G/2.5G/10G");
});

test("the medium comes from whatever was said: itself, the connector, or the speed's name", () => {
  assert.equal(mediumFrom("electrical", null, null), "copper");
  assert.equal(mediumFrom("optical", null, null), "fibre");
  assert.equal(mediumFrom("Copper", null, null), "copper");
  assert.equal(mediumFrom(null, "RJ45", null), "copper");
  assert.equal(mediumFrom(null, "LC", null), "fibre");
  // A cage is a socket, not a medium — read as fibre, which is what one almost always holds.
  assert.equal(mediumFrom(null, "SFP+", null), "fibre");
  // A direct-attach copper cable in that same cage is electrical, and can be said outright.
  assert.equal(mediumFrom("DAC", "SFP+", null), "copper");
  // The speed's own name settles it when nothing else does.
  assert.equal(mediumFrom(null, null, "1000BASE-T"), "copper");
  assert.equal(mediumFrom(null, null, "10GBASE-SR"), "fibre");
  assert.equal(mediumFrom(null, null, "10G"), null, "nothing to go on");
});

test("port ranges expand and print back tidily", () => {
  assert.deepEqual(parsePortList("1-8"), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(parsePortList("1,3,5"), [1, 3, 5]);
  assert.deepEqual(parsePortList("9-11, 12"), [9, 10, 11, 12]);
  assert.deepEqual(parsePortList(12), [12]);
  assert.deepEqual(parsePortList("8-5"), [5, 6, 7, 8], "backwards still means the same range");
  assert.deepEqual(parsePortList("nope"), []);
  assert.equal(formatPortList([1, 2, 3, 5, 7, 8]), "1-3,5,7-8");
  assert.equal(formatPortList([4]), "4");
});

/** The user's own switch: 8 gigabit RJ45, 3 multi-gig, and a 10G cage. */
const SWITCH = device("XGS1250-12", {
  device: "l2-switch",
  ports: 12,
  port_groups: [
    { ports: "1-8", speeds: "10/100/1000", connector: "RJ45" },
    { ports: "9-11", speeds: "1/2.5G", connector: "RJ45" },
    { ports: 12, speeds: "10G", connector: "SFP+" },
  ],
  port_config: [{ port: 12, mode: "trunk", vlan: 1, label: "to the core" }],
});

test("a port resolves from its hardware group, with its configuration on top", () => {
  const first = resolvePort(SWITCH, 1);
  assert.deepEqual(first.speeds, [10, 100, 1000]);
  assert.equal(first.maxSpeed, 1000);
  assert.equal(first.medium, "copper");
  assert.equal(first.connector, "RJ45");

  const multi = resolvePort(SWITCH, 10);
  assert.deepEqual(multi.speeds, [1000, 2500]);

  // The cage carries both the hardware from its group and the configuration from its own entry.
  const cage = resolvePort(SWITCH, 12);
  assert.equal(cage.medium, "fibre");
  assert.equal(cage.maxSpeed, 10000);
  assert.equal(cage.mode, "trunk");
  assert.equal(cage.label, "to the core");
});

test("a per-port entry overrides its group, which is what an exception is", () => {
  const withDac = device("SW", {
    device: "l2-switch",
    ports: 12,
    port_groups: [{ ports: "9-12", speeds: "10G", connector: "SFP+" }],
    port_config: [{ port: 12, medium: "DAC", speeds: "10G", label: "stacked" }],
  });
  assert.equal(resolvePort(withDac, 11).medium, "fibre");
  assert.equal(resolvePort(withDac, 12).medium, "copper", "a direct-attach cable in the same cage");
});

test("a port nothing describes resolves to unknowns rather than to nothing", () => {
  const bare = device("SW", { device: "l2-switch", ports: 5 });
  const port = resolvePort(bare, 3);
  assert.deepEqual([port.speeds, port.medium, port.maxSpeed], [[], null, null]);
  assert.equal(port.poe, false);
});

test("the port inventory reads the way a datasheet does", () => {
  const tallies = portTallies(SWITCH);
  assert.deepEqual(tallies.map(describeTally), [
    "1 × 10G SFP+",
    "3 × 1G/2.5G RJ45",
    "8 × 10M/100M/1G RJ45",
  ]);
  // PoE is counted as its own kind of port, since it is why you would choose one.
  const poe = device("PoE switch", { device: "l2-switch", ports: 8, poe_ports: [1, 2, 3, 4], port_groups: [{ ports: "1-8", speeds: "2.5G", connector: "RJ45" }] });
  assert.deepEqual(portTallies(poe).map(describeTally), ["4 × 2.5G RJ45 PoE", "4 × 2.5G RJ45"]);
});

test("a link runs at the fastest speed BOTH ends support", () => {
  const fast = resolvePort(SWITCH, 12); // 10G
  const multi = resolvePort(SWITCH, 10); // 1G/2.5G
  const gig = resolvePort(SWITCH, 1); // 10M/100M/1G

  // 1G/2.5G into 10M/100M/1G: they share gigabit, and the multi-gig end is the one held back.
  const verdict = linkVerdict(multi, gig);
  assert.deepEqual(verdict, { ok: true, speed: 1000, limitedBy: "far" });

  // Same pair the other way round: the limit is now the near end.
  assert.deepEqual(linkVerdict(gig, multi), { ok: true, speed: 1000, limitedBy: "near" });

  // Matching ends are not "limited" by anything.
  assert.deepEqual(linkVerdict(gig, gig), { ok: true, speed: 1000, limitedBy: null });

  // Nothing in common only really happens on fibre, where there is no fallback: a 1G SFP module
  // in a 10G-only cage is the classic version of it.
  const gigOptic = resolvePort(
    device("Far end", { device: "l2-switch", ports: 1, port_groups: [{ ports: 1, speeds: "1G", connector: "SFP" }] }),
    1
  );
  assert.equal(fast.medium, "fibre");
  assert.deepEqual(linkVerdict(fast, gigOptic), { ok: false, reason: "speed" });
});

test("fibre does not go into RJ45, whatever the speeds say", () => {
  const optical = resolvePort(SWITCH, 12);
  const electrical = resolvePort(SWITCH, 1);
  assert.deepEqual(linkVerdict(optical, electrical), { ok: false, reason: "medium" });
});

test("an unknown end is not an objection — most ports are undocumented at first", () => {
  const known = resolvePort(SWITCH, 1);
  const unknown = resolvePort(device("SW", { device: "l2-switch", ports: 5 }), 2);
  assert.deepEqual(linkVerdict(known, unknown), { ok: true, speed: null, limitedBy: null });
});

test("a copper port negotiates down the BASE-T ladder; an optic does not", () => {
  const copper = device("SW", { device: "l2-switch", ports: 2, port_groups: [{ ports: 1, speeds: "2.5G", connector: "RJ45" }, { ports: 2, speeds: "10G", connector: "SFP+" }] });
  const rj45 = resolvePort(copper, 1);
  const cage = resolvePort(copper, 2);
  // Displayed as written…
  assert.deepEqual(rj45.speeds, [2500]);
  // …but a 2.5GBASE-T port really does 1G and 100M as well.
  assert.deepEqual(effectiveSpeeds(rj45), [100, 1000, 2500]);
  // An SFP+ optic is taken at its word: it will not fall back to gigabit.
  assert.deepEqual(effectiveSpeeds(cage), [10000]);

  // So 2.5G copper into gigabit copper is an ordinary gigabit link, not an incompatibility.
  const gig = resolvePort(device("SW2", { device: "l2-switch", ports: 1, port_groups: [{ ports: 1, speeds: "1G", connector: "RJ45" }] }), 1);
  assert.deepEqual(linkVerdict(rj45, gig), { ok: true, speed: 1000, limitedBy: "far" });
});

const HW = (over: Partial<import("../src/ports").PortHardware> = {}) => ({
  medium: null,
  connector: null,
  speeds: [],
  poe: null,
  label: null,
  ...over,
});

test("setting the hardware of some ports takes them out of whatever group they were in", () => {
  const groups = applyPortHardware([], [1, 2, 3, 4, 5, 6, 7, 8], HW({ speeds: [1000], connector: "RJ45", medium: "copper" }));
  assert.deepEqual(groups.map((g) => formatPortList(g.ports)), ["1-8"]);

  // Move ports 7 and 8 to a different speed: the first group shrinks, a second appears.
  const split = applyPortHardware(groups, [7, 8], HW({ speeds: [2500], connector: "RJ45", medium: "copper" }));
  assert.deepEqual(split.map((g) => [formatPortList(g.ports), formatSpeeds(g.speeds)]), [
    ["1-6", "1G"],
    ["7-8", "2.5G"],
  ]);
});

test("groups that end up identical are merged, so repeated edits do not shred them", () => {
  let groups = applyPortHardware([], [1, 2], HW({ speeds: [1000], medium: "copper" }));
  groups = applyPortHardware(groups, [3, 4], HW({ speeds: [1000], medium: "copper" }));
  groups = applyPortHardware(groups, [5], HW({ speeds: [1000], medium: "copper" }));
  assert.equal(groups.length, 1);
  assert.equal(formatPortList(groups[0].ports), "1-5");
});

test("clearing a port's hardware removes it, and an emptied group goes with it", () => {
  const groups = applyPortHardware([], [1, 2], HW({ speeds: [1000] }));
  assert.deepEqual(applyPortHardware(groups, [1, 2], HW()), []);
  const partial = applyPortHardware(groups, [2], HW());
  assert.deepEqual(partial.map((g) => formatPortList(g.ports)), ["1"]);
});

test("configuration is per port, and keeps any hardware override already on it", () => {
  const start = applyPortConfig([], [12], { mode: "trunk", vlan: 1, allowed: [1, 20], label: "to the core" });
  assert.deepEqual(start.map((c) => [c.port, c.mode, c.vlan, c.allowed]), [[12, "trunk", 1, [1, 20]]]);

  const withOverride = start.map((c) => ({ ...c, medium: "copper" as const, speeds: [10000] }));
  const changed = applyPortConfig(withOverride, [12], { mode: "access", vlan: 20, allowed: [], label: null });
  assert.equal(changed[0].mode, "access");
  assert.equal(changed[0].medium, "copper", "the DAC override survives a VLAN change");
  assert.deepEqual(changed[0].speeds, [10000]);

  // Nothing set removes the entry entirely.
  assert.deepEqual(applyPortConfig(changed, [12], { mode: null, vlan: null, allowed: [], label: null }), []);
});

test("what goes back into frontmatter is what a person would have typed", () => {
  const groups = applyPortHardware([], [1, 2, 3, 4, 5, 6, 7, 8], HW({ speeds: [10, 100, 1000], connector: "RJ45", medium: "copper" }));
  assert.deepEqual(portGroupsToFrontmatter(groups), [{ ports: "1-8", speeds: "10M/100M/1G", medium: "copper", connector: "RJ45" }]);
  // Nothing empty is written, so a note does not fill up with nulls.
  assert.deepEqual(portGroupsToFrontmatter(applyPortHardware([], [12], HW({ speeds: [10000] }))), [{ ports: "12", speeds: "10G" }]);
  assert.deepEqual(portConfigToFrontmatter(applyPortConfig([], [3], { mode: "access", vlan: 20, allowed: [], label: null })), [
    { port: 3, mode: "access", vlan: 20 },
  ]);
});

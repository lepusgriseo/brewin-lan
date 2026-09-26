import { test } from "node:test";
import assert from "node:assert/strict";

import { buildNetwork } from "../src/network";
import { buildTopology, INTERNET_ID, LayoutOptions } from "../src/topology";
import { DEVICES, NET, SEGMENTS, TYPES, device } from "./fixtures";

const OPTS: LayoutOptions = { mode: "tree", nodeSpacing: 100, levelSpacing: 80, showInternet: true, types: TYPES };

const byTitle = (topo: ReturnType<typeof buildTopology>, title: string) => topo.nodes.find((n) => n.title === title)!;

test("the tree reads internet → router → switch/extender → leaves", () => {
  const topo = buildTopology(NET, OPTS);
  assert.deepEqual(
    topo.nodes.map((n) => [n.title, n.depth]),
    [
      ["Internet", 0],
      ["Sky Router", 1],
      ["SW1", 2],
      ["Cats", 2],
      ["RasPutin", 3],
      ["Laptop", 3],
      ["Phone", 3],
    ]
  );
  // The spine sorts before the leaves at each level, so a switch sits left of what hangs off it.
  assert.ok(byTitle(topo, "SW1").x < byTitle(topo, "Cats").x);
});

test("a parent sits over the middle of its children", () => {
  const topo = buildTopology(NET, OPTS);
  const cats = byTitle(topo, "Cats");
  const laptop = byTitle(topo, "Laptop");
  const phone = byTitle(topo, "Phone");
  assert.equal(cats.x, (laptop.x + phone.x) / 2);
  // And the internet sits over the gateway it feeds.
  assert.equal(topo.nodes.find((n) => n.id === INTERNET_ID)!.x, byTitle(topo, "Sky Router").x);
});

test("edges carry the port, and a trunk port is marked as one", () => {
  const topo = buildTopology(NET, OPTS);
  const toRaspu = topo.edges.find((e) => e.to.endsWith("RasPutin.md"))!;
  assert.equal(toRaspu.port, 3);
  assert.equal(toRaspu.trunk, false);

  // Move RasPutin onto SW1's trunk port and the edge says so.
  const trunked = DEVICES.map((d) => (d.title === "RasPutin" ? { ...d, uplinkPort: 5 } : d));
  const topo2 = buildTopology(buildNetwork(trunked, SEGMENTS), OPTS);
  assert.equal(topo2.edges.find((e) => e.to.endsWith("RasPutin.md"))!.trunk, true);
});

test("nodes are coloured by their first placed segment, and labelled with its address", () => {
  const topo = buildTopology(NET, OPTS);
  assert.equal(byTitle(topo, "RasPutin").segment?.title, "Sky LAN");
  assert.equal(byTitle(topo, "RasPutin").ip, "192.168.0.51");
  assert.equal(topo.nodes.find((n) => n.id === INTERNET_ID)!.segment, null);
});

test("no internet node without a gateway to hang it from", () => {
  const net = buildNetwork([device("SW1", { device: "switch" }), device("Laptop", { device: "laptop", uplink: "[[SW1]]" })], SEGMENTS);
  const topo = buildTopology(net, OPTS);
  assert.ok(!topo.nodes.some((n) => n.id === INTERNET_ID));
  assert.deepEqual(topo.nodes.map((n) => n.depth), [0, 1]);
});

test("a loop still draws: the closing link is cut but kept, marked as a cycle", () => {
  const net = buildNetwork(
    [device("SW-A", { device: "switch", uplink: "[[SW-B]]" }), device("SW-B", { device: "switch", uplink: "[[SW-A]]" })],
    SEGMENTS
  );
  const topo = buildTopology(net, OPTS);
  assert.equal(topo.nodes.length, 2);
  assert.equal(topo.edges.filter((e) => e.cycle).length, 1);
  assert.equal(topo.edges.filter((e) => !e.cycle).length, 1);
});

test("a device whose uplink matches nothing is flagged detached but still placed", () => {
  const net = buildNetwork([device("Orphan", { device: "laptop", uplink: "[[Ghost]]" })], SEGMENTS);
  const topo = buildTopology(net, OPTS);
  assert.equal(topo.nodes.length, 1);
  assert.equal(topo.nodes[0].detached, true);
});

test("retired kit is left out unless asked for", () => {
  const net = buildNetwork([...DEVICES, device("Old Pi", { device: "sbc", status: "retired", ip: "192.168.0.99/24" })], SEGMENTS);
  assert.ok(!buildTopology(net, OPTS).nodes.some((n) => n.title === "Old Pi"));
  assert.ok(buildTopology(net, { ...OPTS, includeRetired: true }).nodes.some((n) => n.title === "Old Pi"));
});

test("VLAN mode puts infrastructure on top and one band per segment", () => {
  const topo = buildTopology(NET, { ...OPTS, mode: "vlan" });
  assert.deepEqual(topo.bands.map((b) => b.label), ["Infrastructure", "Sky LAN"]);
  // Everything that hosts others is in the top band whatever its address.
  const infra = topo.nodes.filter((n) => n.y === 0).map((n) => n.title);
  assert.deepEqual(infra.sort(), ["Cats", "SW1", "Sky Router"]);
  // The clients sit in their segment's band, ordered by address.
  const lan = topo.nodes.filter((n) => n.y === topo.bands[1].y).sort((a, b) => a.x - b.x);
  assert.deepEqual(lan.map((n) => n.title), ["RasPutin", "Laptop", "Phone"]);
  // Uplink edges survive the change of layout — that is what makes the crossings readable. Only
  // the synthetic internet edge is absent, since VLAN mode draws no internet.
  const uplinks = (t: ReturnType<typeof buildTopology>) => t.edges.filter((e) => e.from !== INTERNET_ID).length;
  assert.equal(uplinks(topo), uplinks(buildTopology(NET, OPTS)));
  assert.ok(!topo.nodes.some((n) => n.id === INTERNET_ID));
});

test("VLAN mode gives strays their own band rather than dropping them", () => {
  const net = buildNetwork([...DEVICES, device("Mystery", { device: "iot", ip: "172.16.9.9/24" })], SEGMENTS);
  const topo = buildTopology(net, { ...OPTS, mode: "vlan" });
  assert.deepEqual(topo.bands.map((b) => b.label), ["Infrastructure", "Sky LAN", "No segment"]);
  assert.equal(topo.nodes.find((n) => n.title === "Mystery")!.y, topo.bands[2].y);
});

test("an empty network lays out without throwing", () => {
  const topo = buildTopology(buildNetwork([], SEGMENTS), OPTS);
  assert.deepEqual([topo.nodes, topo.edges, topo.roots], [[], [], []]);
  assert.deepEqual(topo.bounds, { minX: 0, minY: 0, maxX: 0, maxY: 0 });
});

test("bounds cover everything drawn", () => {
  const topo = buildTopology(NET, OPTS);
  const xs = topo.nodes.map((n) => n.x);
  const ys = topo.nodes.map((n) => n.y);
  assert.deepEqual(topo.bounds, { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) });
});

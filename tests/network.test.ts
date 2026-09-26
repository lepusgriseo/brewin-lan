import { test } from "node:test";
import assert from "node:assert/strict";

import { buildNetwork, devicesOn, linkPorts, nextFreeIn, parentLinks, resolveDevice, segmentLabel, unplaced, usedIn } from "../src/network";
import { DEVICES, NET, SEGMENTS, device, segment } from "./fixtures";

test("addresses land in the right segment by longest-prefix match", () => {
  const raspu = NET.placements.filter((p) => p.device.title === "RasPutin");
  assert.deepEqual(
    raspu.map((p) => [p.iface.name, p.segment?.title ?? null]),
    [
      ["wlan0", "Sky LAN"],
      ["eth0", "Lab link"],
      // No segment note covers the WireGuard tunnel — that is a gap, not a guess.
      ["wg0", null],
    ]
  );
});

test("an explicit VLAN tag beats the address", () => {
  // Tagged VLAN 20 but addressed out of the Sky LAN: the tag wins, and health then reports the
  // contradiction rather than the parser hiding it.
  const net = buildNetwork([device("Plug", { device: "iot", ip: "192.168.0.80/24", vlan: 20 })], SEGMENTS);
  assert.equal(net.placements[0].segment?.vlanId, 20);
});

test("a more specific subnet wins over a wider one", () => {
  const wide = segment("Everything", { name: "Everything", cidr: "192.168.0.0/16" });
  const net = buildNetwork([device("X", { ip: "192.168.0.51/24" })], [wide, ...SEGMENTS]);
  assert.equal(net.placements[0].segment?.title, "Sky LAN");
});

test("segment labels read as VLAN or as a plain subnet", () => {
  assert.equal(segmentLabel(SEGMENTS[0]), "Sky LAN");
  assert.equal(segmentLabel(SEGMENTS[1]), "VLAN 20 · IoT");
});

test("uplinks resolve by title, hostname or filename", () => {
  assert.equal(resolveDevice("SW1", DEVICES)?.title, "SW1");
  assert.equal(resolveDevice("sky-router", DEVICES)?.title, "Sky Router");
  assert.equal(resolveDevice("Nothing here", DEVICES), null);
  assert.equal(resolveDevice(null, DEVICES), null);
});

test("an uplink loop is cut, and the cut is remembered", () => {
  const a = device("SW-A", { device: "switch", uplink: "[[SW-B]]" });
  const b = device("SW-B", { device: "switch", uplink: "[[SW-A]]" });
  const links = parentLinks([a, b]);
  const cut = links.filter((l) => l.cutParent !== null);
  assert.equal(cut.length, 1, "exactly one link is cut, so the other still draws");
  assert.equal(links.filter((l) => l.parent !== null).length, 1);
});

test("a device naming itself is caught as its own loop", () => {
  const [only] = parentLinks([device("Weird", { device: "switch", uplink: "[[Weird]]" })]);
  assert.equal(only.parent, null);
  assert.equal(only.cutParent, "04_Areas/Network/Devices/Weird.md");
});

test("an uplink to a note that doesn't exist is detached, not a loop", () => {
  const [only] = parentLinks([device("Orphan", { device: "laptop", uplink: "[[Ghost]]" })]);
  assert.equal(only.detached, true);
  assert.equal(only.cutParent, null);
});

test("used addresses and next free respect the pool, reservations and the gateway", () => {
  const lan = SEGMENTS[0];
  const used = usedIn(NET, lan).sort((a, b) => a - b);
  assert.equal(used.length, 6, "router, extender, switch, server, laptop, phone");
  // .1–.63 is reserved and .64–.253 is the pool, which leaves exactly one address a static
  // assignment may legitimately take.
  assert.equal(nextFreeIn(NET, lan), "192.168.0.254");
  // Ignoring the reservation, the first free address below the pool is .3.
  assert.equal(nextFreeIn(NET, lan, { avoidReserved: false }), "192.168.0.3");
  // A DHCP client may of course have a pool address.
  assert.equal(nextFreeIn(NET, lan, { avoidPool: false, avoidReserved: false }), "192.168.0.3");
});

test("next free on an empty segment starts after the gateway", () => {
  const iot = SEGMENTS[1];
  assert.equal(nextFreeIn(NET, iot), "192.168.20.2");
});

test("a segment listing is ordered by address", () => {
  assert.deepEqual(
    devicesOn(NET, SEGMENTS[0]).map((p) => p.iface.ip),
    ["192.168.0.1", "192.168.0.2", "192.168.0.9", "192.168.0.51", "192.168.0.70", "192.168.0.71"]
  );
});

test("addresses no segment explains are listed on their own", () => {
  assert.deepEqual(
    unplaced(NET).map((p) => p.iface.ip),
    ["10.10.10.1"]
  );
});

test("link ports read from the device's own point of view", () => {
  assert.equal(linkPorts({ uplinkPort: 24, localPort: 1 }), ":24⇄1");
  assert.equal(linkPorts({ uplinkPort: 24, localPort: null }), ":24");
  assert.equal(linkPorts({ uplinkPort: null, localPort: 1 }), ":?⇄1");
  // A wireless uplink has no ports at all, and should add nothing to a label.
  assert.equal(linkPorts({ uplinkPort: null, localPort: null }), "");
});

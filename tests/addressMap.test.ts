import { test } from "node:test";
import assert from "node:assert/strict";

import { addressMap, allSegmentStats } from "../src/addressMap";
import { buildNetwork } from "../src/network";
import { NET, SEGMENTS, device, segment } from "./fixtures";

test("a /24 draws every address, plus the network and broadcast for context", () => {
  const map = addressMap(NET, SEGMENTS[0]);
  assert.equal(map.truncated, false);
  assert.equal(map.cells.length, 256);
  assert.equal(map.cells[0].state, "network");
  assert.equal(map.cells[255].state, "broadcast");
});

test("each cell knows what it is: gateway, device, pool, reserved or free", () => {
  const map = addressMap(NET, SEGMENTS[0]);
  const at = (ip: string) => map.cells.find((c) => c.ip === ip)!;
  assert.equal(at("192.168.0.1").state, "gateway");
  assert.equal(at("192.168.0.51").state, "device");
  assert.equal(at("192.168.0.51").placement?.device.title, "RasPutin");
  // .2–.63 is reserved, .64–.253 is the pool.
  assert.equal(at("192.168.0.30").state, "reserved");
  assert.equal(at("192.168.0.200").state, "pool");
  assert.equal(at("192.168.0.254").state, "free");
  // A device inside the pool still reads as a device, but says it is pooled.
  assert.equal(at("192.168.0.70").state, "device");
  assert.equal(at("192.168.0.70").inPool, true);
});

test("statistics add up to the usable size of the subnet", () => {
  const { stats } = addressMap(NET, SEGMENTS[0]);
  assert.equal(stats.usable, 254);
  assert.equal(stats.used, 6);
  assert.equal(stats.pool, 190, ".64 to .253");
  assert.equal(stats.reserved, 63, ".1 to .63");
  // Everything is either used, pooled, reserved or free-for-static — with overlaps counted once in
  // freeStatic, which is the number that answers "can I give this server an address".
  assert.equal(stats.freeStatic, 1);
  assert.equal(Math.round(stats.utilisation * 1000) / 1000, Math.round((6 / 254) * 1000) / 1000);
});

test("a point-to-point link has no network or broadcast cell to waste", () => {
  const p2p = segment("Link", { name: "Link", cidr: "10.9.9.0/31" });
  const net = buildNetwork([device("A", { ip: "10.9.9.0/31" }), device("B", { ip: "10.9.9.1/31" })], [p2p]);
  const map = addressMap(net, p2p);
  assert.deepEqual(map.cells.map((c) => c.ip), ["10.9.9.0", "10.9.9.1"]);
  assert.equal(map.stats.usable, 2);
  assert.equal(map.stats.used, 2);
});

test("a subnet too big to draw reports itself truncated but still counts", () => {
  const big = segment("Flat", { name: "Flat", cidr: "10.0.0.0/16" });
  const net = buildNetwork([device("A", { ip: "10.0.5.5/16" })], [big]);
  const map = addressMap(net, big);
  assert.equal(map.truncated, true);
  assert.deepEqual(map.cells, []);
  assert.equal(map.stats.usable, 65534);
  assert.equal(map.stats.used, 1);
});

test("a segment with no CIDR yields nothing rather than throwing", () => {
  const vague = segment("Someday", { name: "Someday" });
  const map = addressMap(buildNetwork([], [vague]), vague);
  assert.deepEqual([map.cells, map.truncated, map.stats.usable], [[], false, 0]);
});

test("the overview row summarises every segment without building any grid", () => {
  const rows = allSegmentStats(NET);
  assert.deepEqual(
    rows.map((r) => [r.segment.title, r.stats.used]),
    [
      ["Sky LAN", 6],
      ["IoT", 0],
      ["Lab link", 1],
    ]
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  broadcastOf,
  cidrsOverlap,
  compareIps,
  formatCidr,
  formatRange,
  hostRange,
  inRange,
  inSubnet,
  intToIp,
  ipToInt,
  isIpv6,
  maskOf,
  maskToPrefix,
  nextFreeIp,
  normaliseMac,
  parseAddress,
  parseCidr,
  parseRange,
  usableHosts,
} from "../src/ip";

const int = (ip: string): number => ipToInt(ip)!;

test("dotted quads round-trip, and nonsense is rejected", () => {
  assert.equal(ipToInt("0.0.0.0"), 0);
  assert.equal(ipToInt("255.255.255.255"), 4294967295);
  assert.equal(intToIp(int("192.168.0.51")), "192.168.0.51");
  // The top bit set must stay unsigned — the classic place a shift-based implementation goes wrong.
  assert.equal(intToIp(int("10.0.0.1")), "10.0.0.1");
  assert.equal(intToIp(int("224.0.0.251")), "224.0.0.251");
  for (const bad of ["192.168.0.256", "192.168.0", "192.168.0.1.1", "", "abc", "192.168.0.-1"]) {
    assert.equal(ipToInt(bad), null, bad);
  }
});

test("netmasks: prefix 0 and 32 are both real, and a non-contiguous mask is not a mask", () => {
  assert.equal(maskOf(0), 0);
  assert.equal(maskOf(24), int("255.255.255.0"));
  assert.equal(maskOf(32), 4294967295);
  assert.equal(maskToPrefix("255.255.255.0"), 24);
  assert.equal(maskToPrefix("255.255.254.0"), 23);
  assert.equal(maskToPrefix("0.0.0.0"), 0);
  assert.equal(maskToPrefix("255.255.0.255"), null);
});

test("a CIDR normalises to its network, however it was written", () => {
  assert.equal(formatCidr(parseCidr("192.168.0.0/24")!), "192.168.0.0/24");
  // A host address with a prefix is the commonest way people write a subnet down.
  assert.equal(formatCidr(parseCidr("192.168.0.51/24")!), "192.168.0.0/24");
  assert.equal(formatCidr(parseCidr("10.0.0.1")!), "10.0.0.1/32");
  assert.equal(parseCidr("192.168.0.0/33"), null);
  assert.equal(parseCidr("garbage/24"), null);
});

test("an address keeps its host part — and tolerates how notes actually write it", () => {
  assert.deepEqual(parseAddress("192.168.0.51/24"), { ip: "192.168.0.51", prefix: 24 });
  // The live RasPutin note writes a space before the prefix.
  assert.deepEqual(parseAddress("192.168.0.51 /24 (wlan0, LAN, static)"), { ip: "192.168.0.51", prefix: 24 });
  assert.deepEqual(parseAddress("10.0.0.1 255.255.255.0"), { ip: "10.0.0.1", prefix: 24 });
  assert.deepEqual(parseAddress("  10.10.10.1  "), { ip: "10.10.10.1", prefix: null });
  assert.equal(parseAddress("no address here"), null);
});

test("subnet membership, broadcast and usable counts", () => {
  const lan = parseCidr("192.168.0.0/24")!;
  assert.ok(inSubnet(int("192.168.0.51"), lan));
  assert.ok(!inSubnet(int("192.168.5.51"), lan));
  assert.equal(intToIp(broadcastOf(lan)), "192.168.0.255");
  assert.equal(usableHosts(24), 254);
  assert.equal(usableHosts(30), 2);
  // A /31 link has two usable addresses and no broadcast; a /32 has one. Treating these like any
  // other subnet would report a point-to-point lab link as having none.
  assert.equal(usableHosts(31), 2);
  assert.equal(usableHosts(32), 1);
  assert.deepEqual(
    [hostRange(lan).start, hostRange(lan).end].map(intToIp),
    ["192.168.0.1", "192.168.0.254"]
  );
  const p2p = parseCidr("10.0.0.0/31")!;
  assert.deepEqual([hostRange(p2p).start, hostRange(p2p).end].map(intToIp), ["10.0.0.0", "10.0.0.1"]);
});

test("overlap is symmetric and catches containment, not just equality", () => {
  const a = parseCidr("192.168.0.0/24")!;
  const b = parseCidr("192.168.0.128/25")!;
  const c = parseCidr("192.168.1.0/24")!;
  assert.ok(cidrsOverlap(a, b));
  assert.ok(cidrsOverlap(b, a));
  assert.ok(!cidrsOverlap(a, c));
  assert.ok(cidrsOverlap(parseCidr("0.0.0.0/0")!, c));
});

test("ranges: full, the last-octet shorthand, a single address, and the ones to refuse", () => {
  assert.equal(formatRange(parseRange("192.168.0.100-192.168.0.199")!), "192.168.0.100–192.168.0.199");
  assert.equal(formatRange(parseRange("192.168.0.100-199")!), "192.168.0.100–192.168.0.199");
  assert.equal(formatRange(parseRange("192.168.0.10")!), "192.168.0.10");
  assert.equal(parseRange("192.168.0.199-192.168.0.100"), null, "backwards");
  assert.equal(parseRange("192.168.0.100-300"), null, "octet over 255");
  assert.ok(inRange(int("192.168.0.150"), parseRange("192.168.0.100-199")!));
  assert.ok(!inRange(int("192.168.0.200"), parseRange("192.168.0.100-199")!));
});

test("next free address skips what is used, the pool and anything reserved", () => {
  const lan = parseCidr("192.168.0.0/24")!;
  const used = [int("192.168.0.1"), int("192.168.0.2")];
  assert.equal(nextFreeIp(lan, { used }), "192.168.0.3");
  assert.equal(
    nextFreeIp(lan, { used, avoid: [parseRange("192.168.0.3-20")!] }),
    "192.168.0.21"
  );
  // Starting part-way up is how "give me the next server address" behaves.
  assert.equal(nextFreeIp(lan, { used, from: int("192.168.0.50") }), "192.168.0.50");
  // A full subnet returns null rather than the broadcast address.
  const tiny = parseCidr("10.0.0.0/30")!;
  assert.equal(nextFreeIp(tiny, { used: [int("10.0.0.1"), int("10.0.0.2")] }), null);
});

test("MAC addresses fold to one spelling", () => {
  assert.equal(normaliseMac("2C:CF:67:5B:70:26"), "2c:cf:67:5b:70:26");
  assert.equal(normaliseMac("2c-cf-67-5b-70-26"), "2c:cf:67:5b:70:26");
  assert.equal(normaliseMac("2ccf675b7026"), "2c:cf:67:5b:70:26");
  assert.equal(normaliseMac("2c:cf:67:5b:70"), null);
});

test("IPv6 is recognised so it can be kept aside, and addresses sort numerically", () => {
  assert.ok(isIpv6("2001:db8::10"));
  assert.ok(isIpv6("fe80::1%wlan0"));
  assert.ok(!isIpv6("192.168.0.1"));
  const sorted = ["192.168.0.10", "192.168.0.9", "192.168.0.100"].sort(compareIps);
  assert.deepEqual(sorted, ["192.168.0.9", "192.168.0.10", "192.168.0.100"]);
});

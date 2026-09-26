import { test } from "node:test";
import assert from "node:assert/strict";

import { countBySeverity, findIssues } from "../src/health";
import { buildNetwork } from "../src/network";
import { DEVICES, NET, SEGMENTS, TYPES, device, segment } from "./fixtures";

const OPTS = { types: TYPES };
const find = (net: ReturnType<typeof buildNetwork>, code: string) => findIssues(net, OPTS).filter((i) => i.code === code);

test("the fixture network has nothing actually broken", () => {
  const { error } = countBySeverity(findIssues(NET, OPTS));
  assert.equal(error, 0, "a healthy network must produce no errors at all, or the list is noise");
});

test("but it does report the gaps: an unexplained address and a missing segment note", () => {
  // RasPutin's WireGuard address falls in no segment — a real gap in the documentation.
  const noSegment = find(NET, "no-segment");
  assert.equal(noSegment.length, 1);
  assert.match(noSegment[0].message, /10\.10\.10\.1/);
});

test("two devices on one address is an error naming both", () => {
  const clash = device("Printer", { device: "printer", ip: "192.168.0.51/24", mac: "cc:cc:cc:00:00:01" });
  const net = buildNetwork([...DEVICES, clash], SEGMENTS);
  const [issue] = find(net, "duplicate-ip");
  assert.equal(issue.severity, "error");
  assert.match(issue.message, /192\.168\.0\.51 is claimed by 2 interfaces/);
  assert.match(issue.message, /RasPutin/);
  assert.match(issue.message, /Printer/);
  assert.ok(issue.otherPath);
});

test("one MAC on two devices is an error; the same NIC recorded twice is not", () => {
  const twin = device("Clone", { device: "laptop", ip: "192.168.0.90/24", mac: "bb:bb:bb:00:00:70" });
  assert.equal(find(buildNetwork([...DEVICES, twin], SEGMENTS), "duplicate-mac").length, 1);
  // A device with the same MAC on two of its own interface records is a documentation quirk, not
  // a clash on the wire.
  const selfSame = device("Dual", { device: "server", interfaces: [{ name: "eth0", ip: "192.168.0.91", mac: "dd:dd:dd:00:00:01" }, { name: "eth1", ip: "192.168.0.92", mac: "dd:dd:dd:00:00:01" }] });
  assert.equal(find(buildNetwork([selfSame], SEGMENTS), "duplicate-mac").length, 0);
});

test("a VLAN tag that contradicts the address is an error, not a silent reassignment", () => {
  const plug = device("Plug", { device: "iot", ip: "192.168.0.80/24", vlan: 20 });
  const [issue] = find(buildNetwork([plug], SEGMENTS), "ip-outside-segment");
  assert.equal(issue.severity, "error");
  assert.match(issue.message, /VLAN 20 · IoT but 192\.168\.0\.80 is outside 192\.168\.20\.0\/24/);
});

test("a VLAN with no segment note is reported once per interface", () => {
  const plug = device("Plug", { device: "iot", ip: "192.168.99.5/24", vlan: 99 });
  assert.deepEqual(find(buildNetwork([plug], SEGMENTS), "unknown-vlan").length, 1);
});

test("a wrong prefix is a warning even when the address is in range", () => {
  const nas = device("NAS", { device: "nas", ip: "192.168.0.30/16" });
  const [issue] = find(buildNetwork([nas], SEGMENTS), "prefix-mismatch");
  assert.match(issue.message, /uses \/16 but Sky LAN is 192\.168\.0\.0\/24/);
});

test("a static address inside the DHCP pool is the classic home-network fault", () => {
  const server = device("Media", { device: "server", ip: "192.168.0.100/24", assign: "static" });
  const [issue] = find(buildNetwork([server], SEGMENTS), "static-in-pool");
  assert.equal(issue.severity, "warn");
  assert.match(issue.message, /the server can hand it to something else/);
  // A DHCP client in the pool is exactly right and must not be reported.
  const client = device("Tablet", { device: "tablet", ip: "192.168.0.101/24", assign: "dhcp" });
  assert.equal(find(buildNetwork([client], SEGMENTS), "static-in-pool").length, 0);
});

test("segment notes are checked too: gateway, pool and reservations against the CIDR", () => {
  const bad = segment("Broken", { name: "Broken", cidr: "10.5.0.0/24", gateway: "10.6.0.1", dhcp_range: "10.7.0.10-20", reserved: ["10.8.0.1"] });
  const issues = findIssues(buildNetwork([], [bad]), OPTS);
  const found = issues.map((i) => i.code);
  assert.ok(found.includes("gateway-outside-cidr"));
  assert.ok(found.includes("pool-outside-cidr"));
  assert.ok(found.includes("reserved-outside-cidr"));
  assert.equal(issues.find((i) => i.code === "gateway-outside-cidr")?.severity, "error");
});

test("a segment with no readable CIDR says so and stops there", () => {
  const vague = segment("Guest", { name: "Guest", cidr: "sometime soon" });
  const found = findIssues(buildNetwork([], [vague]), OPTS);
  assert.deepEqual(found.map((i) => i.code), ["segment-no-cidr"]);
});

test("overlapping segments and a reused VLAN id", () => {
  const a = segment("A", { vlan: 10, name: "A", cidr: "192.168.0.0/24" });
  const b = segment("B", { vlan: 10, name: "B", cidr: "192.168.0.128/25" });
  const found = findIssues(buildNetwork([], [a, b]), OPTS).map((i) => i.code);
  assert.ok(found.includes("segments-overlap"));
  assert.ok(found.includes("duplicate-vlan-id"));
});

test("uplink faults: unresolved, a loop, something that hosts nothing, a bad port", () => {
  const net = buildNetwork(
    [
      device("SW1", { device: "switch", ports: 5 }),
      device("Orphan", { device: "laptop", uplink: "[[Ghost]]" }),
      device("A", { device: "switch", uplink: "[[B]]" }),
      device("B", { device: "switch", uplink: "[[A]]" }),
      device("Odd", { device: "laptop", uplink: "[[Orphan]]" }),
      device("Far", { device: "laptop", uplink: "[[SW1]]", uplink_port: 9 }),
    ],
    SEGMENTS
  );
  const found = findIssues(net, OPTS);
  const has = (code: string) => found.some((i) => i.code === code);
  assert.ok(has("uplink-unresolved"));
  assert.ok(has("uplink-cycle"));
  assert.ok(has("uplink-not-a-host"));
  assert.ok(has("port-out-of-range"));
  assert.match(found.find((i) => i.code === "port-out-of-range")!.message, /port 9 on SW1, which has 5 ports/);
});

test("two devices on one switch port is an error", () => {
  const net = buildNetwork(
    [
      device("SW1", { device: "switch", ports: 5 }),
      device("A", { device: "laptop", uplink: "[[SW1]]", uplink_port: 3 }),
      device("B", { device: "desktop", uplink: "[[SW1]]", uplink_port: 3 }),
    ],
    SEGMENTS
  );
  const [issue] = find(net, "port-conflict");
  assert.equal(issue.severity, "error");
  assert.match(issue.message, /Port 3 on SW1 is claimed by 2 devices: A, B/);
});

test("an unknown device type is reported rather than quietly relabelled", () => {
  const net = buildNetwork([device("Thing", { device: "toaster", ip: "192.168.0.44/24" })], SEGMENTS);
  assert.match(find(net, "unknown-type")[0].message, /device type "toaster"/);
});

test("gaps are info, not faults: no MAC, no address at all, an undocumented gateway", () => {
  const net = buildNetwork([device("Bare", { device: "server", ip: "192.168.0.45/24" }), device("Nothing", { device: "iot" })], SEGMENTS);
  const found = findIssues(net, OPTS);
  assert.equal(found.find((i) => i.code === "no-mac")?.severity, "info");
  assert.ok(found.some((i) => i.code === "no-address"));
  // Nothing in this cut-down network claims .1, so the gateway is undocumented.
  assert.ok(found.some((i) => i.code === "gateway-undocumented"));
  // In the full fixture the router documents .1 and RasPutin's eth0 documents the lab gateway, so
  // the only one left unclaimed is the IoT VLAN nothing is plugged into yet.
  assert.deepEqual(
    findIssues(NET, OPTS)
      .filter((i) => i.code === "gateway-undocumented")
      .map((i) => i.message),
    ["Nothing documents 192.168.20.1, the gateway of VLAN 20 · IoT."]
  );
});

test("retired kit is documentation, not a clash", () => {
  const old = device("Old Pi", { device: "sbc", status: "retired", ip: "192.168.0.51/24" });
  assert.equal(find(buildNetwork([...DEVICES, old], SEGMENTS), "duplicate-ip").length, 0);
  assert.equal(findIssues(buildNetwork([...DEVICES, old], SEGMENTS), { ...OPTS, includeRetired: true }).filter((i) => i.code === "duplicate-ip").length, 1);
});

test("errors sort above warnings above information", () => {
  const net = buildNetwork([...DEVICES, device("Clash", { device: "printer", ip: "192.168.0.51/24" })], SEGMENTS);
  const severities = findIssues(net, OPTS).map((i) => i.severity);
  const rank = { error: 0, warn: 1, info: 2 } as const;
  assert.deepEqual(severities, [...severities].sort((a, b) => rank[a] - rank[b]));
});

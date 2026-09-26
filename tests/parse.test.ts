import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_DEVICE_TYPES, isManageable, normaliseTypeId } from "../src/deviceTypes";
import { deviceFromNote, hasTag, hostnameFrom, linkText, NoteInput, parseIfaceEntry, segmentFromNote } from "../src/parse";

const T = DEFAULT_DEVICE_TYPES;

const note = (basename: string, frontmatter: Record<string, unknown>, path?: string): NoteInput => ({
  path: path ?? `04_Areas/Network/Devices/${basename}.md`,
  basename,
  frontmatter,
  mtime: 1_700_000_000_000,
});

test("the live RasPutin note parses as-is, prose and all", () => {
  // Copied verbatim from 04_Areas/Home Lab/RasPutin.md — the note predates the plugin and must
  // keep working untouched.
  const d = deviceFromNote(
    note("RasPutin", {
      up: "[[Home Lab]]",
      tags: ["homelab", "server"],
      Name: "RasPutin",
      OS: "Raspberry Pi OS",
      IP: [
        "192.168.0.51 /24 (wlan0, LAN, static — router direct, was 192.168.5.116 via a WiFi extender until 2026-08-03)",
        "10.0.0.1 /24 (eth0, wired lab link)",
        "10.10.10.1 /24 (wg0, WireGuard tunnel)",
      ],
      MAC: "2c:cf:67:5b:70:26",
      location: "Office",
      status: "Active",
      Purpose: "Ultimate Frankenstein",
      Services: ["[[Jellyfin]]", "[[NextCloud Guide|Nextcloud]]", "Nginx Proxy Manager", "[[Home Assistant]]"],
    }),
    T
  );

  assert.equal(d.title, "RasPutin");
  assert.equal(d.hostname, "rasputin");
  assert.equal(d.status, "active");
  assert.equal(d.location, "Office");
  assert.deepEqual(
    d.ifaces.map((i) => [i.name, i.ip, i.prefix]),
    [
      ["wlan0", "192.168.0.51", 24],
      ["eth0", "10.0.0.1", 24],
      ["wg0", "10.10.10.1", 24],
    ]
  );
  // The flat MAC belongs to the first address; the prose is kept, not discarded.
  assert.equal(d.ifaces[0].mac, "2c:cf:67:5b:70:26");
  assert.equal(d.ifaces[0].assign, "static");
  assert.match(d.ifaces[0].note, /was 192\.168\.5\.116 via a WiFi extender/);
  assert.equal(d.ifaces[1].assign, "unknown");
  assert.deepEqual(d.services, ["Jellyfin", "NextCloud Guide", "Nginx Proxy Manager", "Home Assistant"]);
  assert.equal(d.notes, "Ultimate Frankenstein");
});

test("the structured form: one address, a type, an uplink and a port", () => {
  const d = deviceFromNote(
    note("Laptop", {
      device: "laptop",
      status: "active",
      ip: "192.168.0.20/24",
      mac: "AA-BB-CC-DD-EE-FF",
      vlan: 10,
      assign: "dhcp",
      uplink: "[[04_Areas/Network/Devices/SW1|SW1]]",
      uplink_port: 3,
    }),
    T
  );
  assert.equal(d.type, "laptop");
  assert.deepEqual(
    d.ifaces.map((i) => [i.name, i.ip, i.prefix, i.vlan, i.mac, i.assign]),
    [["primary", "192.168.0.20", 24, 10, "aa:bb:cc:dd:ee:ff", "dhcp"]]
  );
  assert.equal(d.uplink, "SW1");
  assert.equal(d.uplinkPort, 3);
});

test("interfaces as mappings, alongside a flat primary address", () => {
  const d = deviceFromNote(
    note("Edge", {
      device: "router",
      ip: "192.168.0.1/24",
      interfaces: [
        { name: "wan0", ip: "203.0.113.9/30", assign: "static" },
        { name: "eth1", ip: "10.0.0.1/24", vlan: 20, mac: "00:11:22:33:44:55" },
      ],
      ports: 4,
      poe_ports: [1, 2],
      port_config: [
        { port: 4, mode: "trunk", vlan: 1, allowed: [1, 20, 30], label: "to SW1" },
        { port: 2, mode: "access", vlan: 20 },
      ],
    }),
    T
  );
  assert.deepEqual(d.ifaces.map((i) => i.name), ["primary", "wan0", "eth1"]);
  assert.equal(d.ifaces[1].ip, "203.0.113.9");
  assert.equal(d.ifaces[2].vlan, 20);
  assert.equal(d.ports, 4);
  assert.deepEqual(d.poePorts, [1, 2]);
  // Port config is sorted by port, so a note listing them out of order still reads in order.
  assert.deepEqual(d.portConfig.map((p) => [p.port, p.mode, p.vlan]), [[2, "access", 20], [4, "trunk", 1]]);
  assert.deepEqual(d.portConfig[1].allowed, [1, 20, 30]);
});

test("a device known only by MAC is still a device", () => {
  const d = deviceFromNote(note("Doorbell", { device: "iot", mac: "001122334455", vlan: 30 }), T);
  assert.equal(d.ifaces.length, 1);
  assert.deepEqual([d.ifaces[0].ip, d.ifaces[0].mac, d.ifaces[0].vlan], [null, "00:11:22:33:44:55", 30]);
});

test("IPv6 is kept aside rather than fed to the IPv4 maths", () => {
  const d = deviceFromNote(note("Server", { device: "server", ip: ["192.168.0.9/24", "2001:db8::9"], ipv6: ["fe80::1"] }), T);
  assert.deepEqual(d.ifaces.map((i) => i.ip), ["192.168.0.9"]);
  assert.deepEqual(d.ipv6, ["fe80::1"]);
});

test("frontmatter keys are matched loosely, because notes are written by hand", () => {
  const d = deviceFromNote(note("NAS", { Device: "NAS", "DHCP Range": "ignored here", Hostname: "pinas", "Uplink Port": "2", Uplink: "SW1" }), T);
  assert.equal(d.type, "nas");
  assert.equal(d.hostname, "pinas");
  assert.equal(d.uplinkPort, 2);
  assert.equal(d.uplink, "SW1");
});

test("written type names fold onto ids, and an unknown one keeps itself", () => {
  // `switch` predates the L2/L3 split; an unqualified one is what anybody writing it meant.
  assert.equal(normaliseTypeId("Switch", T), "l2-switch");
  assert.equal(normaliseTypeId("switches", T), "l2-switch");
  assert.equal(normaliseTypeId("L2 switch", T), "l2-switch");
  assert.equal(normaliseTypeId("layer-3-switch", T), "l3-switch");
  assert.equal(normaliseTypeId("L3 Switch", T), "l3-switch");
  assert.equal(normaliseTypeId("core switch", T), "l3-switch");
  assert.equal(normaliseTypeId("managed switch", T), "l2-switch");
  assert.equal(normaliseTypeId("Access point", T), "ap");
  assert.equal(normaliseTypeId("Router / gateway", T), "router");
  // Not silently relabelled `other` — the health panel reports it so the typo is visible.
  assert.equal(normaliseTypeId("toaster", T), "toaster");
});

test("status folds the vault's own vocabulary", () => {
  const status = (s: unknown) => deviceFromNote(note("X", { status: s }), T).status;
  assert.equal(status("Active"), "active");
  assert.equal(status("online"), "active");
  assert.equal(status("In Progress"), "planned");
  assert.equal(status("Retired"), "retired");
  assert.equal(status(undefined), "active");
});

test("hostnames and links", () => {
  assert.equal(hostnameFrom("Sky Router"), "sky-router");
  assert.equal(hostnameFrom("RasPutin"), "rasputin");
  assert.equal(hostnameFrom("Kid's iPad (2021)"), "kid-s-ipad-2021");
  assert.equal(linkText("[[04_Areas/Network/Devices/SW1|Switch one]]"), "SW1");
  assert.equal(linkText("[[SW1]]"), "SW1");
  assert.equal(linkText("SW1"), "SW1");
  assert.equal(linkText(undefined), null);
});

test("a segment note: VLAN, CIDR, gateway, pool and reservations", () => {
  const s = segmentFromNote(
    note("VLAN 20 — IoT", {
      vlan: 20,
      name: "IoT",
      cidr: "192.168.20.0/24",
      gateway: "192.168.20.1",
      dhcp_range: "192.168.20.100-199",
      reserved: ["192.168.20.1-20", "192.168.20.250"],
      colour: "amber",
      purpose: "Smart plugs and cameras, no route to the trusted VLAN.",
    })
  );
  assert.equal(s.vlanId, 20);
  assert.equal(s.title, "IoT");
  assert.equal(s.cidr?.prefix, 24);
  assert.equal(s.gateway, "192.168.20.1");
  assert.deepEqual([s.pool?.start, s.pool?.end].map((n) => n! >>> 0).length, 2);
  assert.equal(s.reserved.length, 2);
  assert.equal(s.colour, "amber");
});

test("an untagged segment is legal — most home networks have no VLANs at all", () => {
  const s = segmentFromNote(note("Sky LAN", { cidr: "192.168.0.0/24", gateway: "192.168.0.1" }));
  assert.equal(s.vlanId, null);
  assert.equal(s.title, "Sky LAN");
  assert.equal(s.cidr?.prefix, 24);
});

test("a nested marker tag still counts for its parent", () => {
  assert.ok(hasTag(["Network/Device"], "Network/Device"));
  assert.ok(hasTag(["#network/device/static"], "Network/Device"));
  assert.ok(hasTag(["homelab", "Network/Device"], "Network/Device"));
  assert.ok(!hasTag(["Network/VLAN"], "Network/Device"));
});

test("a single loose address line parses on its own", () => {
  const i = parseIfaceEntry("10.0.0.1 /24 (eth0, wired lab link)", "primary")!;
  assert.deepEqual([i.name, i.ip, i.prefix, i.note], ["eth0", "10.0.0.1", 24, "eth0, wired lab link"]);
  assert.equal(parseIfaceEntry("not an address", "primary"), null);
});

test("both ends of a link are recorded, under any of the spellings people use", () => {
  const d = deviceFromNote(note("SW2", { device: "l2-switch", uplink: "[[SW1]]", uplink_port: 24, local_port: 1, ports: 8 }), T);
  assert.equal(d.uplinkPort, 24, "the far end: a port on SW1");
  assert.equal(d.localPort, 1, "the near end: a port on SW2 itself");
  // `remote_port` reads more naturally to some people than `uplink_port`; `own port` likewise.
  const alt = deviceFromNote(note("SW3", { device: "l2-switch", uplink: "[[SW1]]", "remote port": 12, "own port": 2 }), T);
  assert.deepEqual([alt.uplinkPort, alt.localPort], [12, 2]);
  // Neither is required — a wireless uplink has no ports at all.
  const wireless = deviceFromNote(note("Phone", { device: "phone", uplink: "[[AP]]" }), T);
  assert.deepEqual([wireless.uplinkPort, wireless.localPort], [null, null]);
});

test("managed is three-state, because silence is not a claim", () => {
  const managed = (v: unknown) => deviceFromNote(note("SW", { device: "l2-switch", managed: v }), T).managed;
  assert.equal(managed(true), true);
  assert.equal(managed("managed"), true);
  assert.equal(managed("web-smart"), true, "the marketing word for a cheap managed switch");
  assert.equal(managed("SNMP"), true);
  assert.equal(managed(false), false);
  assert.equal(managed("unmanaged"), false);
  assert.equal(managed("non-managed"), false);
  assert.equal(managed("dumb"), false);
  // Not recorded stays null: the health check must not invent a fault from an unanswered question.
  assert.equal(managed(undefined), null);
  assert.equal(managed("who knows"), null);
});

test("an L2 switch can be asked whether it is managed; a phone cannot", () => {
  assert.ok(isManageable("l2-switch", T));
  assert.ok(isManageable("l3-switch", T));
  assert.ok(!isManageable("phone", T));
  assert.ok(!isManageable("server", T));
});

test("a more specific type name beats a more general one inside the same phrase", () => {
  // The bug this guards: "switch" matches before "l3" ever gets a look in.
  assert.equal(normaliseTypeId("Cisco L3 switch", T), "l3-switch");
  assert.equal(normaliseTypeId("48-port l2 switch", T), "l2-switch");
  assert.equal(normaliseTypeId("poe access point", T), "ap");
  assert.equal(normaliseTypeId("toaster", T), "toaster");
});

test("a games console never folds onto the switch type", () => {
  // "Switch" is a Nintendo as often as it is a switch; only the console type may claim it, and it
  // deliberately has no alias for it, so the word alone still means the network device.
  assert.equal(normaliseTypeId("Nintendo Switch", T), "l2-switch");
  assert.equal(normaliseTypeId("console", T), "console");
  assert.equal(normaliseTypeId("games console", T), "console");
});

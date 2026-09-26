import { test } from "node:test";
import assert from "node:assert/strict";

import { csvExport, dnsmasqHostRecords, dnsmasqReservations, hostsFile, markdownTable, runExport } from "../src/exports";
import { buildNetwork } from "../src/network";
import { DEVICES, NET, SEGMENTS, device } from "./fixtures";

const OPTS = { domain: "rasputin.lan" };
const lines = (text: string) => text.trim().split("\n").filter((l) => !l.startsWith("#"));

test("DHCP reservations: one line per device, lowest address first", () => {
  const out = dnsmasqReservations(NET, OPTS);
  assert.deepEqual(lines(out.text), [
    "dhcp-host=aa:aa:aa:00:00:01,192.168.0.1,sky-router",
    "dhcp-host=aa:aa:aa:00:00:02,192.168.0.2,cats",
    "dhcp-host=aa:aa:aa:00:00:09,192.168.0.9,sw1",
    "dhcp-host=2c:cf:67:5b:70:26,192.168.0.51,rasputin",
    "dhcp-host=bb:bb:bb:00:00:70,192.168.0.70,laptop",
    "dhcp-host=bb:bb:bb:00:00:71,192.168.0.71,phone",
  ]);
  assert.equal(out.count, 6);
  // RasPutin has three addresses but one reservation — a DHCP server hands out one per MAC.
  assert.equal(out.text.match(/rasputin/g)?.length, 1);
});

test("what cannot be exported is reported with a reason, not dropped", () => {
  const net = buildNetwork(
    [
      ...DEVICES,
      device("Doorbell", { device: "iot", ip: "192.168.0.60/24" }),
      device("Future NAS", { device: "nas", status: "planned", ip: "192.168.0.61/24", mac: "ee:ee:ee:00:00:01" }),
      device("Old Pi", { device: "sbc", status: "retired", ip: "192.168.0.62/24", mac: "ee:ee:ee:00:00:02" }),
    ],
    SEGMENTS
  );
  const out = dnsmasqReservations(net, OPTS);
  // Reported in note order, so the list reads the same way the inventory does.
  assert.deepEqual(out.skipped, [
    { device: "Doorbell", reason: "no MAC recorded" },
    { device: "Future NAS", reason: "planned, not built yet" },
  ]);
  // Retired kit is simply not network configuration, so it is not even a skip.
  assert.ok(!out.text.includes("ee:ee:ee:00:00:02"));
  assert.ok(dnsmasqReservations(net, { ...OPTS, includePlanned: true }).text.includes("ee:ee:ee:00:00:01"));
});

test("name records cover every interface, and secondary ones get their own name", () => {
  const out = dnsmasqHostRecords(NET, OPTS);
  const text = out.text;
  assert.ok(text.includes("host-record=rasputin,rasputin.rasputin.lan,192.168.0.51"));
  // The second and third interfaces are named after the interface, so both are resolvable and
  // neither steals the plain hostname.
  assert.ok(text.includes("host-record=rasputin-eth0,rasputin-eth0.rasputin.lan,10.0.0.1"));
  assert.ok(text.includes("host-record=rasputin-wg0,rasputin-wg0.rasputin.lan,10.10.10.1"));
  assert.equal(out.count, 8);
});

test("a hosts file aligns the addresses, qualifies the names and sorts numerically", () => {
  const out = hostsFile(NET, OPTS);
  const rows = lines(out.text);
  // Numeric order, so 10.0.0.1 precedes 192.168.x — the order a generated file should be in.
  assert.match(rows[0], /^10\.0\.0\.1\s+rasputin-eth0\.rasputin\.lan rasputin-eth0$/);
  assert.match(rows[2], /^192\.168\.0\.1\s+sky-router\.rasputin\.lan sky-router$/);
  assert.ok(rows.every((l) => l.includes(".rasputin.lan")));
  // The address column is padded to a common width, so every name starts in the same column.
  const nameColumn = (line: string): number => line.length - line.replace(/^\S+\s+/, "").length;
  assert.equal(new Set(rows.map(nameColumn)).size, 1);
});

test("the markdown table links the note and names the port", () => {
  const out = markdownTable(NET, OPTS);
  assert.match(out.text, /\| \[\[RasPutin\]\] \| server \| 192\.168\.0\.51\/24 \| Sky LAN \| 2c:cf:67:5b:70:26 \| SW1:3 \| active \|/);
});

test("CSV quotes what needs quoting and keeps a stable column order", () => {
  const net = buildNetwork([device("Study, back room", { device: "iot", ip: "192.168.0.88/24", location: "Study" })], SEGMENTS);
  const out = csvExport(net, OPTS);
  const [header, row] = out.text.trim().split("\n");
  assert.equal(header, "device,hostname,type,status,interface,ip,prefix,mac,vlan,segment,uplink,uplink_port,location");
  assert.ok(row.startsWith('"Study, back room",study-back-room,iot,active,primary,192.168.0.88,24,'));
});

test("every format is reachable through one entry point", () => {
  for (const format of ["dnsmasq-dhcp", "dnsmasq-dns", "hosts", "markdown", "csv"] as const) {
    assert.ok(runExport(format, NET, OPTS).text.length > 0, format);
  }
});

test("an empty network exports headers and no rows", () => {
  const empty = buildNetwork([], SEGMENTS);
  const out = dnsmasqReservations(empty, OPTS);
  assert.equal(out.count, 0);
  assert.deepEqual(lines(out.text), []);
});

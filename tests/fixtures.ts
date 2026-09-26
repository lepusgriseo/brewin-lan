// A small network shaped like the real one: an ISP router, a WiFi extender that NATs its own
// subnet, a managed switch, a server with three interfaces, and two clients.

import { DEFAULT_DEVICE_TYPES } from "../src/deviceTypes";
import { deviceFromNote, segmentFromNote, NoteInput } from "../src/parse";
import { buildNetwork } from "../src/network";
import { Device, Segment } from "../src/types";

export const TYPES = DEFAULT_DEVICE_TYPES;

export const note = (basename: string, frontmatter: Record<string, unknown>, folder = "04_Areas/Network/Devices"): NoteInput => ({
  path: `${folder}/${basename}.md`,
  basename,
  frontmatter,
  mtime: 1_700_000_000_000,
});

export const device = (basename: string, fm: Record<string, unknown>): Device => deviceFromNote(note(basename, fm), TYPES);

export const segment = (basename: string, fm: Record<string, unknown>): Segment =>
  segmentFromNote(note(basename, fm, "04_Areas/Network/Segments"));

export const SEGMENTS: Segment[] = [
  segment("Sky LAN", {
    name: "Sky LAN",
    cidr: "192.168.0.0/24",
    gateway: "192.168.0.1",
    dhcp_range: "192.168.0.64-253",
    reserved: ["192.168.0.1-63"],
  }),
  segment("VLAN 20 — IoT", { vlan: 20, name: "IoT", cidr: "192.168.20.0/24", gateway: "192.168.20.1", dhcp_range: "192.168.20.100-199" }),
  segment("Lab link", { name: "Lab link", cidr: "10.0.0.0/24", gateway: "10.0.0.1" }),
];

export const DEVICES: Device[] = [
  device("Sky Router", { device: "router", ip: "192.168.0.1/24", mac: "aa:aa:aa:00:00:01", assign: "static", ports: 4, location: "Hall" }),
  device("Cats", { device: "extender", ip: "192.168.0.2/24", mac: "aa:aa:aa:00:00:02", assign: "static", uplink: "[[Sky Router]]", uplink_port: 1 }),
  device("SW1", {
    device: "switch",
    ip: "192.168.0.9/24",
    mac: "aa:aa:aa:00:00:09",
    assign: "static",
    ports: 5,
    uplink: "[[Sky Router]]",
    uplink_port: 2,
    port_config: [{ port: 5, mode: "trunk", vlan: 1, allowed: [1, 20] }],
  }),
  device("RasPutin", {
    device: "server",
    status: "Active",
    IP: [
      "192.168.0.51 /24 (wlan0, LAN, static — router direct)",
      "10.0.0.1 /24 (eth0, wired lab link)",
      "10.10.10.1 /24 (wg0, WireGuard tunnel)",
    ],
    MAC: "2c:cf:67:5b:70:26",
    uplink: "[[SW1]]",
    uplink_port: 3,
    location: "Office",
  }),
  device("Laptop", { device: "laptop", ip: "192.168.0.70/24", mac: "bb:bb:bb:00:00:70", assign: "dhcp", uplink: "[[Cats]]" }),
  device("Phone", { device: "phone", ip: "192.168.0.71/24", mac: "bb:bb:bb:00:00:71", assign: "dhcp", uplink: "[[Cats]]" }),
];

export const NET = buildNetwork(DEVICES, SEGMENTS);

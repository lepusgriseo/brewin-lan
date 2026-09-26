# Brewin LAN

An Obsidian plugin that treats your home network as notes: one per device, one per VLAN or subnet.
It reads their frontmatter and draws the topology, checks the addressing, maps the switch ports and
generates DHCP, DNS and hosts configuration from the same data.

Nothing is stored in the plugin. Every note works with it switched off.

## What it does

- **Topology diagram** built from each device's `uplink:` — internet → router → switches → leaves,
  laid out so each parent sits over the middle of its children. Icons are the device type, colour is
  the segment, and a small tag on each link is the port (bold for a trunk). A second layout puts one
  band per VLAN with the uplinks still drawn, so the crossings show what sits where.
- **Device profiles** — interfaces, segment, assignment, MAC, uplink, services, and for anything with
  ports a **port map** whose occupancy is derived from which devices claim which port, never stored
  twice. Two devices on one port is therefore detectable rather than invisible.
- **Address map** per segment: every address tagged device / gateway / pool / reserved / free, with
  usage figures and the next free static address. Tap a free one to create a device on it.
- **Health checks**, split by how much they matter: *errors* are things that cannot both be true (a
  duplicate address or MAC, an address outside its segment, two claims on one port — including a
  switch's own uplink port — a reused VLAN id, an uplink loop); *warnings* are the documentation
  arguing with itself (a static address inside the DHCP pool, an uplink pointing at nothing,
  overlapping subnets, a VLAN configured on a switch marked unmanaged); *gaps* are what is simply
  not written down yet, and what that costs you.
- **Exports** — dnsmasq reservations, dnsmasq `host-record` (forward *and* reverse), `/etc/hosts`,
  a Markdown table, CSV. Each says what it left out and why, because a silently missing reservation
  is how a "static" address quietly moves one day.

It never touches the network: no scanning, no SSH, no calls out. It is a documentation tool that
happens to be able to check its own documentation.

## The notes it reads

A device is any note tagged `Network/Device` (anywhere in the vault — the tag is the marker, the
folder is only where new ones are created). A note inside the devices folder also counts if it
carries an `ip`, `mac` or `device` field.

```yaml
---
tags: [Network/Device]
device: l2-switch       # picks the icon, and whether things can plug into it
managed: true           # L2/L3 switches: an unmanaged one cannot carry a VLAN
status: active          # active | planned | offline | retired
ip: 192.168.0.51/24     # a list is fine, and so is prose after the address
mac: 2c:cf:67:5b:70:26  # needed for a DHCP reservation
vlan: 20                # an explicit tag, which beats matching the address to a subnet
assign: static          # static | dhcp | reserved
uplink: "[[SW1]]"       # this is what draws the diagram
uplink_port: 3          # the far end: a port on SW1
local_port: 1           # the near end: a port on this device
ports: 8                # for anything others plug into
poe_ports: [1, 2, 3]
hostname: rasputin
location: Office
---
```

**Both ends of a link are recorded.** Knowing a cable lands on SW1's port 24 does not tell you which
of SW2's own ports it left from — and that port is occupied on SW2 either way, so a switch's uplink
port used to look free and could be handed to something else. `uplink_port` is theirs, `local_port`
is ours, and the diagram labels the link `24⇄1`.

**Device types** are `router`, `firewall`, `l2-switch`, `l3-switch`, `ap`, `extender`, `server`,
`nas`, `sbc`, `vm`, `desktop`, `laptop`, `phone`, `tablet`, `tv`, `console`, `printer`, `camera`,
`iot` and `other`, each with its own icon, and editable in settings. Written names are folded onto
them, most specific first: a plain `switch` is an `l2-switch`, "Cisco L3 switch" is an `l3-switch`,
"managed switch" and "access point" land where you would expect. `managed:` is a property rather
than a pair of types, because it is one bit of information and not a different kind of thing — and
it is three-state, since "nobody has said" must not be read as "it cannot do VLANs".

A VLAN or subnet is a note tagged `Network/VLAN`, with `vlan` (omit it for an untagged subnet —
which is what most home networks are), `cidr`, `gateway`, `dhcp_range`, `reserved`, `colour` and
`purpose`. Multi-homed devices can use an `interfaces:` list of mappings instead of the flat fields;
`port_config:` describes access and trunk ports.

**Parsing is deliberately tolerant.** These notes are written by hand and usually predate the
plugin, so an address field like

```yaml
IP:
  - 192.168.0.51 /24 (wlan0, LAN, static — router direct, was 192.168.5.116 until 2026-08-03)
```

yields the interface name, address, prefix and assignment, and keeps the rest of the sentence rather
than dropping it. Refusing to read that would mean rewriting your notes to suit the code.

## Views, commands, settings

One view with five tabs (topology, devices, addresses, health, export), on the `network` ribbon icon.
Commands: *Open LAN*, *New device*, *New VLAN or subnet*, *Check the network*, and *Mark this note as
a device* for a note you already keep elsewhere.

Settings cover the two marker tags, the two folders, the local domain used by the exports, the
layout and spacing, whether to draw the internet, whether retired kit counts, and the device-type
list — each type an id, a label, a [Lucide](https://lucide.dev) icon name, and whether other
devices can plug into it.

## Installing

Not in the community directory. Either install from this repository with
[BRAT](https://github.com/TfTHacker/obsidian42-brat), or copy `main.js`, `manifest.json` and
`styles.css` into `<vault>/.obsidian/plugins/brewin-lan/` and enable it.

## Building

```bash
npm install
npm run dev      # watch
npm run build    # type-check, then bundle
npm test         # 116 tests
```

The addressing, layout, health, export and viewport maths are pure modules with no Obsidian imports,
which is why they can be tested at all — `src/settingsData.ts` is split from `src/settings.ts` for
exactly that reason.

## Caveats

Written for one vault, so the default folders match its layout; all of them are settings. IPv6
addresses are recorded and displayed but deliberately kept out of the address arithmetic. No support
is promised.

MIT licensed.

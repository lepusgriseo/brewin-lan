// Everything that can be wrong with the network as documented. Pure, and deliberately opinionated
// about severity:
//
//   error — two things cannot both be true (a duplicate address, two devices on one port)
//   warn  — the documentation contradicts itself or the addressing plan (a static address inside
//           the DHCP pool, an uplink pointing at nothing)
//   info  — a gap rather than a fault (no MAC recorded, so no DHCP reservation can be exported)
//
// The point of the split is that `error` should be empty on a healthy network, so a non-empty
// error list means something really is broken rather than merely undocumented.

import { findType, hostsOthers, isManageable, DeviceType } from "./deviceTypes";
import { cidrsOverlap, inRange, inSubnet, intToIp, ipToInt } from "./ip";
import { inPool, isReserved, Network, parentLinks, segmentKey, segmentLabel } from "./network";
import { formatSpeed, formatSpeeds, linkVerdict, resolvePort } from "./ports";
import { Issue, Segment } from "./types";

export interface HealthOptions {
  types: DeviceType[];
  /** Retired kit is documentation, not a fault — its addresses don't clash with anything. */
  includeRetired?: boolean;
}

const ORDER: Record<string, number> = { error: 0, warn: 1, info: 2 };

export function findIssues(net: Network, opts: HealthOptions): Issue[] {
  const issues: Issue[] = [];
  const live = net.placements.filter((p) => opts.includeRetired || p.device.status !== "retired");
  const add = (severity: Issue["severity"], code: string, message: string, path: string | null, otherPath?: string | null): void => {
    issues.push({ code, severity, message, path, otherPath });
  };

  // ── Address clashes ────────────────────────────────────────────────────────
  const byIp = new Map<number, typeof live>();
  for (const p of live) {
    if (p.ipInt === null) continue;
    byIp.set(p.ipInt, [...(byIp.get(p.ipInt) ?? []), p]);
  }
  for (const [ip, holders] of [...byIp].sort((a, b) => a[0] - b[0])) {
    if (holders.length < 2) continue;
    const who = holders.map((h) => `${h.device.title} (${h.iface.name})`).join(", ");
    add("error", "duplicate-ip", `${intToIp(ip)} is claimed by ${holders.length} interfaces: ${who}.`, holders[0].device.path, holders[1].device.path);
  }

  const byMac = new Map<string, typeof live>();
  for (const p of live) {
    if (!p.iface.mac) continue;
    byMac.set(p.iface.mac, [...(byMac.get(p.iface.mac) ?? []), p]);
  }
  for (const [mac, holders] of [...byMac].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (holders.length < 2) continue;
    const who = [...new Set(holders.map((h) => h.device.title))].join(", ");
    if (new Set(holders.map((h) => h.device.path)).size < 2) continue; // two records of one NIC
    add("error", "duplicate-mac", `MAC ${mac} is recorded on more than one device: ${who}.`, holders[0].device.path, holders[1].device.path);
  }

  // ── Addresses against their segment ────────────────────────────────────────
  for (const p of live) {
    const { device, iface, segment, ipInt } = p;
    if (iface.vlan !== null && !net.segments.some((s) => s.vlanId === iface.vlan)) {
      add("warn", "unknown-vlan", `${device.title} (${iface.name}) is tagged VLAN ${iface.vlan}, which has no segment note.`, device.path);
    }
    if (ipInt === null) continue;
    if (!segment) {
      add("warn", "no-segment", `${iface.ip} on ${device.title} falls in no known segment — no segment note covers it.`, device.path);
      continue;
    }
    if (segment.cidr && !inSubnet(ipInt, segment.cidr)) {
      add(
        "error",
        "ip-outside-segment",
        `${device.title} (${iface.name}) is on ${segmentLabel(segment)} but ${iface.ip} is outside ${segment.cidrText}.`,
        device.path,
        segment.path
      );
    }
    if (iface.prefix !== null && segment.cidr && iface.prefix !== segment.cidr.prefix) {
      add(
        "warn",
        "prefix-mismatch",
        `${device.title} (${iface.name}) uses /${iface.prefix} but ${segmentLabel(segment)} is ${segment.cidrText}.`,
        device.path
      );
    }
    if (iface.assign !== "dhcp" && inPool(ipInt, segment)) {
      const how = iface.assign === "unknown" ? "an address" : `a ${iface.assign} address`;
      add(
        "warn",
        "static-in-pool",
        `${device.title} holds ${how}, ${iface.ip}, inside the DHCP pool of ${segmentLabel(segment)} — the server can hand it to something else.`,
        device.path,
        segment.path
      );
    }
    if (iface.assign === "dhcp" && segment.pool && !inRange(ipInt, segment.pool) && !isReserved(ipInt, segment)) {
      add("info", "dhcp-outside-pool", `${device.title} is marked DHCP but ${iface.ip} is outside the pool of ${segmentLabel(segment)}.`, device.path);
    }
  }

  // ── The segment notes themselves ───────────────────────────────────────────
  for (const segment of net.segments) {
    if (!segment.cidr) {
      add("warn", "segment-no-cidr", `${segment.title} has no usable CIDR${segment.cidrText ? ` (\`${segment.cidrText}\`)` : ""} — nothing can be checked against it.`, segment.path);
      continue;
    }
    const gateway = segment.gateway === null ? null : ipToInt(segment.gateway);
    if (segment.gateway !== null && gateway === null) {
      add("warn", "segment-gateway-invalid", `${segment.title} has an unreadable gateway: \`${segment.gateway}\`.`, segment.path);
    } else if (gateway !== null && !inSubnet(gateway, segment.cidr)) {
      add("error", "gateway-outside-cidr", `${segmentLabel(segment)} has gateway ${segment.gateway}, which is outside ${segment.cidrText}.`, segment.path);
    }
    if (segment.pool && (!inSubnet(segment.pool.start, segment.cidr) || !inSubnet(segment.pool.end, segment.cidr))) {
      add("warn", "pool-outside-cidr", `The DHCP pool of ${segmentLabel(segment)} (\`${segment.poolText}\`) is not inside ${segment.cidrText}.`, segment.path);
    }
    for (const range of segment.reserved) {
      if (!inSubnet(range.start, segment.cidr) || !inSubnet(range.end, segment.cidr)) {
        add("warn", "reserved-outside-cidr", `A reserved range of ${segmentLabel(segment)} is outside ${segment.cidrText}.`, segment.path);
      }
    }
    if (segment.pool && segment.reserved.some((r) => r.start <= (segment.pool as { end: number }).end && r.end >= (segment.pool as { start: number }).start)) {
      add("info", "pool-overlaps-reserved", `The DHCP pool of ${segmentLabel(segment)} overlaps a reserved range — the reservation wins, so the pool is smaller than it looks.`, segment.path);
    }
  }

  for (let i = 0; i < net.segments.length; i++) {
    for (let j = i + 1; j < net.segments.length; j++) {
      const a = net.segments[i];
      const b = net.segments[j];
      if (a.cidr && b.cidr && cidrsOverlap(a.cidr, b.cidr)) {
        add("warn", "segments-overlap", `${segmentLabel(a)} (${a.cidrText}) overlaps ${segmentLabel(b)} (${b.cidrText}).`, a.path, b.path);
      }
      if (a.vlanId !== null && a.vlanId === b.vlanId) {
        add("error", "duplicate-vlan-id", `VLAN ${a.vlanId} is defined twice: ${a.title} and ${b.title}.`, a.path, b.path);
      }
    }
  }

  // ── Uplinks and ports ──────────────────────────────────────────────────────
  const devices = net.devices.filter((d) => opts.includeRetired || d.status !== "retired");
  const links = parentLinks(devices);
  // Keyed by "<device path>#<port>". Both ends of every link are recorded here, because a port is
  // occupied whether the cable arrives or leaves: a switch's own uplink port is not free for a
  // laptop just because the switch is the one that named it.
  const portClaims = new Map<string, { title: string; path: string }[]>();
  const claimPort = (ownerPath: string, port: number, claim: { title: string; path: string }): void => {
    const key = `${ownerPath}#${port}`;
    portClaims.set(key, [...(portClaims.get(key) ?? []), claim]);
  };

  for (const link of links) {
    const { device, parent } = link;
    if (link.cutParent !== null) {
      const other = net.byPath.get(link.cutParent);
      add(
        "error",
        "uplink-cycle",
        link.cutParent === device.path
          ? `${device.title} names itself as its own uplink.`
          : `${device.title} and ${other?.title ?? link.cutParent} form an uplink loop — the diagram cuts it to draw.`,
        device.path,
        link.cutParent
      );
    }
    if (link.detached) {
      add("warn", "uplink-unresolved", `${device.title} uplinks to "${device.uplink}", which matches no device note.`, device.path);
    }
    if (parent) {
      if (!hostsOthers(parent.type, opts.types)) {
        add("warn", "uplink-not-a-host", `${device.title} uplinks to ${parent.title}, which is a ${findType(parent.type, opts.types).label.toLowerCase()} — nothing plugs into that.`, device.path, parent.path);
      }
      if (link.port !== null) {
        if (link.port < 1 || (parent.ports !== null && link.port > parent.ports)) {
          add("warn", "port-out-of-range", `${device.title} claims port ${link.port} on ${parent.title}, which has ${parent.ports ?? "an unknown number of"} ports.`, device.path, parent.path);
        }
        claimPort(parent.path, link.port, { title: device.title, path: device.path });
      }
      // Both ends known? Then the cable itself can be checked — the two most expensive mistakes
      // here are a medium mismatch (which needs hardware, not a cable) and assuming a link runs at
      // the faster end's headline speed when it can only run at what both ends support.
      if (link.port !== null && link.localPort !== null) {
        const far = resolvePort(parent, link.port);
        const near = resolvePort(device, link.localPort);
        const verdict = linkVerdict(near, far);
        if (!verdict.ok && verdict.reason === "medium") {
          add(
            "error",
            "link-medium-mismatch",
            `${device.title} port ${link.localPort} is ${near.medium} but ${parent.title} port ${link.port} is ${far.medium} — that link needs a transceiver or a media converter, not a cable.`,
            device.path,
            parent.path
          );
        } else if (!verdict.ok && verdict.reason === "speed") {
          add(
            "error",
            "link-speed-mismatch",
            `${device.title} port ${link.localPort} (${formatSpeeds(near.speeds)}) and ${parent.title} port ${link.port} (${formatSpeeds(
              far.speeds
            )}) have no speed in common, so the link cannot come up.`,
            device.path,
            parent.path
          );
        } else if (verdict.ok && verdict.speed !== null && verdict.limitedBy !== null) {
          const slow = verdict.limitedBy === "near" ? `${device.title} port ${link.localPort}` : `${parent.title} port ${link.port}`;
          add(
            "info",
            "link-speed-limited",
            `The link between ${device.title} and ${parent.title} runs at ${formatSpeed(verdict.speed)} — ${slow} tops out there, though the other end goes faster.`,
            device.path,
            parent.path
          );
        }
      }
      if (link.localPort !== null) {
        if (link.localPort < 1 || (device.ports !== null && link.localPort > device.ports)) {
          add(
            "warn",
            "local-port-out-of-range",
            `${device.title} uses its own port ${link.localPort} for the link to ${parent.title}, but it has ${device.ports ?? "an unknown number of"} ports.`,
            device.path
          );
        }
        claimPort(device.path, link.localPort, { title: `the uplink to ${parent.title}`, path: device.path });
      }
    } else if (!link.detached && link.cutParent === null && !hostsOthers(device.type, opts.types) && device.status === "active") {
      add("info", "no-uplink", `${device.title} has no uplink, so the diagram can only draw it on its own.`, device.path);
    }
    if (link.localPort !== null && device.uplink === null) {
      add("warn", "local-port-without-uplink", `${device.title} records its own port ${link.localPort} as used by a link, but names no uplink.`, device.path);
    }
    if (!opts.types.some((t) => t.id === device.type)) {
      add("warn", "unknown-type", `${device.title} has device type "${device.type}", which isn't one of the configured types.`, device.path);
    }
  }

  for (const [key, claimants] of [...portClaims].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (claimants.length < 2) continue;
    const [path, port] = key.split("#");
    const owner = net.byPath.get(path);
    add(
      "error",
      "port-conflict",
      `Port ${port} on ${owner?.title ?? path} has ${claimants.length} claims: ${claimants.map((c) => c.title).join(", ")}.`,
      claimants[0].path,
      claimants[1].path
    );
  }

  for (const device of devices) {
    if (device.status !== "active") continue;
    const addressed = device.ifaces.some((i) => i.ip !== null);
    if (!addressed && device.ifaces.every((i) => i.mac === null)) {
      add("info", "no-address", `${device.title} has neither an address nor a MAC recorded.`, device.path);
    } else if (addressed && device.ifaces.every((i) => i.mac === null)) {
      add("info", "no-mac", `${device.title} has no MAC, so no DHCP reservation can be exported for it.`, device.path);
    }
  }

  // A port described in the hardware or config blocks that the device does not have.
  for (const device of devices) {
    if (device.ports === null) continue;
    const beyond = [
      ...new Set([
        ...device.portGroups.flatMap((g) => g.ports),
        ...device.portConfig.map((c) => c.port),
      ]),
    ]
      .filter((p) => p < 1 || p > (device.ports as number))
      .sort((a, b) => a - b);
    if (beyond.length === 0) continue;
    add(
      "warn",
      "port-described-not-present",
      `${device.title} describes port${beyond.length === 1 ? "" : "s"} ${beyond.join(", ")}, but has ${device.ports} ports.`,
      device.path
    );
  }

  // An unmanaged switch cannot tag a frame, so a VLAN written on its ports is a plan that cannot
  // work — worth saying while it is still a plan. Only when the note actually says "unmanaged":
  // silence is not the same claim.
  for (const device of devices) {
    if (device.managed !== false || !isManageable(device.type, opts.types)) continue;
    const tagged = device.portConfig.filter((p) => p.mode === "trunk" || p.vlan !== null);
    if (tagged.length === 0) continue;
    add(
      "warn",
      "unmanaged-switch-vlans",
      `${device.title} is unmanaged, so it cannot tag a frame, but ${tagged.length} of its ports ${
        tagged.length === 1 ? "is" : "are"
      } configured with a VLAN.`,
      device.path
    );
  }

  // Unclaimed gateways come last: useful, but never urgent.
  for (const segment of net.segments) {
    const gateway = segment.gateway === null ? null : ipToInt(segment.gateway);
    if (gateway === null) continue;
    const held = net.placements.some((p) => p.ipInt === gateway && p.segment !== null && segmentKey(p.segment as Segment) === segmentKey(segment));
    if (!held) {
      add("info", "gateway-undocumented", `Nothing documents ${segment.gateway}, the gateway of ${segmentLabel(segment)}.`, segment.path);
    }
  }

  return issues.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
}

export function countBySeverity(issues: Issue[]): { error: number; warn: number; info: number } {
  return {
    error: issues.filter((i) => i.severity === "error").length,
    warn: issues.filter((i) => i.severity === "warn").length,
    info: issues.filter((i) => i.severity === "info").length,
  };
}

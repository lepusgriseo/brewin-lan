import { App, CachedMetadata, normalizePath, TFile, TFolder } from "obsidian";
import { BrewinLanSettings } from "./settings";
import { deviceFromNote, hasTag, hostnameFrom, NoteInput, pick } from "./parse";
import { buildNetwork, Network } from "./network";
import { segmentFromNote } from "./parse";
import { applyPortConfig, applyPortHardware, portConfigToFrontmatter, portGroupsToFrontmatter, PortHardware, PortSetup } from "./ports";
import { Device, DeviceStatus, Segment } from "./types";

/** What the "new device" dialog collects. Everything but the name is optional. */
export interface NewDeviceFields {
  title: string;
  type: string;
  status: DeviceStatus;
  ip: string;
  prefix: number | null;
  mac: string;
  vlan: number | null;
  assign: string;
  uplink: string | null;
  /** Port at the uplink's end. */
  uplinkPort: number | null;
  /** Port at this device's own end. */
  localPort: number | null;
  ports: number | null;
  /** Managed / unmanaged / not recorded — only meaningful for the switch-shaped types. */
  managed: boolean | null;
  location: string;
}

export interface NewSegmentFields {
  title: string;
  vlanId: number | null;
  cidr: string;
  gateway: string;
  pool: string;
  purpose: string;
}

/**
 * The one place that touches the vault.
 *
 * Reads are cheap — frontmatter comes from Obsidian's metadata cache, never from disk — so the
 * network is rebuilt on demand rather than cached, which removes any chance of the view showing
 * something the notes no longer say. Writes go through `processFrontMatter`, so the body of a note
 * is never rewritten by the plugin.
 */
export class LanStore {
  constructor(private app: App, private settings: BrewinLanSettings) {}

  private tagsOf(fm: Record<string, unknown>, cache: CachedMetadata | null): string[] {
    const tags = new Set<string>();
    const raw = fm.tags ?? fm.tag;
    if (Array.isArray(raw)) raw.forEach((t) => tags.add(String(t)));
    else if (typeof raw === "string") raw.split(/[,\s]+/).forEach((t) => t && tags.add(t));
    cache?.tags?.forEach((t) => tags.add(t.tag));
    return [...tags];
  }

  private inFolder(path: string, folder: string): boolean {
    const root = folder.replace(/\/+$/, "");
    return root !== "" && (path === root + ".md" || path.startsWith(root + "/"));
  }

  private notes(): { file: TFile; input: NoteInput; tags: string[] }[] {
    const out: { file: TFile; input: NoteInput; tags: string[] }[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = (cache?.frontmatter ?? {}) as Record<string, unknown>;
      out.push({
        file,
        input: { path: file.path, basename: file.basename, frontmatter: fm, mtime: file.stat.mtime },
        tags: this.tagsOf(fm, cache),
      });
    }
    return out;
  }

  getDevices(): Device[] {
    const devices: Device[] = [];
    for (const { input, tags } of this.notes()) {
      const tagged = hasTag(tags, this.settings.deviceTag);
      // A note sitting in the devices folder counts even untagged — but only if it looks like a
      // device, so the folder's own hub note doesn't turn into a mystery box on the diagram.
      const looksLikeOne = pick(input.frontmatter, "ip", "ipv4", "mac", "device", "interfaces") !== undefined;
      if (!tagged && !(this.inFolder(input.path, this.settings.devicesFolder) && looksLikeOne)) continue;
      devices.push(deviceFromNote(input, this.settings.deviceTypes));
    }
    return devices.sort((a, b) => a.title.localeCompare(b.title));
  }

  getSegments(): Segment[] {
    const segments: Segment[] = [];
    for (const { input, tags } of this.notes()) {
      const tagged = hasTag(tags, this.settings.segmentTag);
      const looksLikeOne = pick(input.frontmatter, "cidr", "subnet", "network") !== undefined;
      if (!tagged && !(this.inFolder(input.path, this.settings.segmentsFolder) && looksLikeOne)) continue;
      segments.push(segmentFromNote(input));
    }
    // VLANs in numeric order, untagged subnets after them — the order the bands and tabs read in.
    return segments.sort((a, b) => {
      if (a.vlanId !== null && b.vlanId !== null) return a.vlanId - b.vlanId;
      if (a.vlanId !== null) return -1;
      if (b.vlanId !== null) return 1;
      return a.title.localeCompare(b.title);
    });
  }

  network(): Network {
    return buildNetwork(this.getDevices(), this.getSegments());
  }

  fileFor(path: string): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? file : null;
  }

  private async ensureFolder(path: string): Promise<void> {
    const parts = normalizePath(path).split("/");
    let sofar = "";
    for (const part of parts) {
      sofar = sofar ? `${sofar}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(sofar);
      if (existing instanceof TFolder) continue;
      if (existing) return; // a file of that name is in the way; let the create fail loudly
      try {
        await this.app.vault.createFolder(sofar);
      } catch {
        /* created concurrently — fine */
      }
    }
  }

  private uniquePath(folder: string, title: string): string {
    const safe = title.replace(/[\\/:*?"<>|#^[\]]/g, "").trim() || "Device";
    let path = normalizePath(`${folder}/${safe}.md`);
    let n = 2;
    while (this.app.vault.getAbstractFileByPath(path)) path = normalizePath(`${folder}/${safe} ${n++}.md`);
    return path;
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  async createDevice(fields: NewDeviceFields): Promise<TFile> {
    await this.ensureFolder(this.settings.devicesFolder);
    const path = this.uniquePath(this.settings.devicesFolder, fields.title);
    const lines = ["---", `up: "[[${this.settings.hubNote}]]"`, "tags:", `  - ${this.settings.deviceTag}`, `device: ${fields.type}`, `status: ${fields.status}`];
    lines.push(`hostname: ${hostnameFrom(fields.title)}`);
    if (fields.ip) lines.push(`ip: ${fields.ip}${fields.prefix !== null ? "/" + fields.prefix : ""}`);
    if (fields.mac) lines.push(`mac: ${fields.mac}`);
    if (fields.vlan !== null) lines.push(`vlan: ${fields.vlan}`);
    if (fields.assign) lines.push(`assign: ${fields.assign}`);
    if (fields.uplink) lines.push(`uplink: "[[${fields.uplink}]]"`);
    if (fields.uplinkPort !== null) lines.push(`uplink_port: ${fields.uplinkPort}`);
    if (fields.localPort !== null) lines.push(`local_port: ${fields.localPort}`);
    if (fields.ports !== null) lines.push(`ports: ${fields.ports}`);
    if (fields.managed !== null) lines.push(`managed: ${fields.managed}`);
    if (fields.location) lines.push(`location: ${fields.location}`);
    lines.push(`created: ${this.today()}`, `modified: ${this.today()}`, "---", "", `# ${fields.title}`, "", "## Notes", "");
    return this.app.vault.create(path, lines.join("\n"));
  }

  async createSegment(fields: NewSegmentFields): Promise<TFile> {
    await this.ensureFolder(this.settings.segmentsFolder);
    const path = this.uniquePath(this.settings.segmentsFolder, fields.title);
    const lines = ["---", `up: "[[${this.settings.hubNote}]]"`, "tags:", `  - ${this.settings.segmentTag}`];
    if (fields.vlanId !== null) lines.push(`vlan: ${fields.vlanId}`);
    lines.push(`name: ${fields.title}`);
    if (fields.cidr) lines.push(`cidr: ${fields.cidr}`);
    if (fields.gateway) lines.push(`gateway: ${fields.gateway}`);
    if (fields.pool) lines.push(`dhcp_range: ${fields.pool}`);
    if (fields.purpose) lines.push(`purpose: ${fields.purpose}`);
    lines.push(`created: ${this.today()}`, `modified: ${this.today()}`, "---", "", `# ${fields.title}`, "", "## Notes", "");
    return this.app.vault.create(path, lines.join("\n"));
  }

  /** Every write goes through here, so `modified:` is always kept honest. */
  private async edit(path: string, mutate: (fm: Record<string, unknown>) => void): Promise<void> {
    const file = this.fileFor(path);
    if (!file) return;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      mutate(fm as Record<string, unknown>);
      (fm as Record<string, unknown>).modified = this.today();
    });
  }

  /**
   * Sets the primary address.
   *
   * Only the flat `ip:` field is touched: a device with an `interfaces:` list has its extra
   * addresses written by hand and the plugin has no business guessing which one was meant.
   */
  async setAddress(device: Device, cidrText: string): Promise<void> {
    await this.edit(device.path, (fm) => {
      const key = "IP" in fm ? "IP" : "ip";
      if (Array.isArray(fm[key])) {
        const list = [...(fm[key] as unknown[])];
        list[0] = cidrText;
        fm[key] = list;
      } else {
        fm[key] = cidrText;
      }
    });
  }

  async setVlan(device: Device, vlan: number | null): Promise<void> {
    await this.edit(device.path, (fm) => {
      if (vlan === null) delete fm.vlan;
      else fm.vlan = vlan;
    });
  }

  /** Both ends of the link at once: `uplink_port` is theirs, `local_port` is ours. */
  async setUplink(device: Device, uplinkTitle: string | null, port: number | null, localPort: number | null = null): Promise<void> {
    await this.edit(device.path, (fm) => {
      if (uplinkTitle === null) {
        delete fm.uplink;
        delete fm.uplink_port;
        delete fm.local_port;
        return;
      }
      fm.uplink = `[[${uplinkTitle}]]`;
      if (port === null) delete fm.uplink_port;
      else fm.uplink_port = port;
      if (localPort === null) delete fm.local_port;
      else fm.local_port = localPort;
    });
  }

  async setStatus(device: Device, status: DeviceStatus): Promise<void> {
    await this.edit(device.path, (fm) => {
      fm.status = status;
    });
  }

  async setManaged(device: Device, managed: boolean | null): Promise<void> {
    await this.edit(device.path, (fm) => {
      if (managed === null) delete fm.managed;
      else fm.managed = managed;
    });
  }

  async setType(device: Device, type: string): Promise<void> {
    await this.edit(device.path, (fm) => {
      fm.device = type;
    });
  }

  async setMac(device: Device, mac: string): Promise<void> {
    await this.edit(device.path, (fm) => {
      const key = "MAC" in fm ? "MAC" : "mac";
      if (mac) fm[key] = mac;
      else delete fm[key];
    });
  }

  async setAssignment(device: Device, assign: string): Promise<void> {
    await this.edit(device.path, (fm) => {
      if (assign) fm.assign = assign;
      else delete fm.assign;
    });
  }

  /** Writes back under whichever spelling the note already uses, so a hand-written key survives. */
  private keyFor(fm: Record<string, unknown>, canonical: string, aliases: string[]): string {
    return aliases.find((a) => a in fm) ?? canonical;
  }

  /**
   * The hardware of some ports: medium, connector, capable speeds, PoE.
   *
   * Rewritten as whole blocks rather than edited in place, because "ports 9–11 are 2.5G" has to
   * behave the same however many groups those ports were previously spread across. The canonical
   * form that comes back is still what a person would have typed.
   */
  async setPortHardware(device: Device, ports: number[], hardware: PortHardware): Promise<void> {
    const groups = applyPortHardware(device.portGroups, ports, hardware);
    await this.edit(device.path, (fm) => {
      const key = this.keyFor(fm, "port_groups", ["port_groups", "portGroups", "port groups", "port types"]);
      const out = portGroupsToFrontmatter(groups);
      if (out.length) fm[key] = out;
      else delete fm[key];
    });
  }

  /** The configuration of some ports: access or trunk, which VLAN, a label. */
  async setPortSetup(device: Device, ports: number[], setup: PortSetup): Promise<void> {
    const configs = applyPortConfig(device.portConfig, ports, setup);
    await this.edit(device.path, (fm) => {
      const key = this.keyFor(fm, "port_config", ["port_config", "portConfig", "port config", "port map"]);
      const out = portConfigToFrontmatter(configs);
      if (out.length) fm[key] = out;
      else delete fm[key];
    });
  }

  /** Adds the device tag to a note that is already about a device — the migration path for the
   *  notes that existed before this plugin did. */
  async adoptNote(path: string): Promise<void> {
    await this.edit(path, (fm) => {
      const tag = this.settings.deviceTag;
      const raw = fm.tags;
      if (Array.isArray(raw)) {
        if (!raw.map(String).some((t) => t.replace(/^#/, "") === tag)) fm.tags = [...raw, tag];
      } else if (typeof raw === "string" && raw) {
        fm.tags = [raw, tag];
      } else {
        fm.tags = [tag];
      }
    });
  }
}

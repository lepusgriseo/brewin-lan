import { App, Modal, Notice, Setting } from "obsidian";
import { DeviceType, isManageable } from "./deviceTypes";
import { normaliseMac, parseAddress } from "./ip";
import { nextFreeIn, Network, segmentKey, segmentLabel } from "./network";
import { LanStore, NewDeviceFields } from "./lanStore";
import { Device, DeviceStatus, Segment } from "./types";

const STATUSES: DeviceStatus[] = ["active", "planned", "offline", "retired"];

/**
 * Create or edit a device.
 *
 * Editing writes field by field through the store rather than rewriting the note, so a device
 * note that also carries prose, extra interfaces or fields this plugin knows nothing about comes
 * through untouched.
 */
export class DeviceModal extends Modal {
  private fields: NewDeviceFields;
  private segment: Segment | null = null;

  constructor(
    app: App,
    private store: LanStore,
    private net: Network,
    private types: DeviceType[],
    private onDone: () => void,
    /** Null to create. */
    private editing: Device | null = null,
    /** Prefill for "use this address", from the address map. */
    prefill: { ip?: string; segment?: Segment } = {}
  ) {
    super(app);
    const iface = editing?.ifaces[0];
    this.segment = prefill.segment ?? (editing ? this.net.placements.find((p) => p.device.path === editing.path)?.segment ?? null : null);
    this.fields = {
      title: editing?.title ?? "",
      type: editing?.type ?? "other",
      status: editing?.status ?? "active",
      ip: prefill.ip ?? iface?.ip ?? "",
      prefix: iface?.prefix ?? this.segment?.cidr?.prefix ?? null,
      mac: iface?.mac ?? "",
      vlan: iface?.vlan ?? null,
      assign: iface?.assign && iface.assign !== "unknown" ? iface.assign : "",
      uplink: editing?.uplink ?? null,
      uplinkPort: editing?.uplinkPort ?? null,
      localPort: editing?.localPort ?? null,
      ports: editing?.ports ?? null,
      managed: editing?.managed ?? null,
      location: editing?.location ?? "",
    };
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("brewin-lan-modal");
    contentEl.createEl("h3", { text: this.editing ? `Edit ${this.editing.title}` : "New device" });

    if (!this.editing) {
      const name = contentEl.createEl("input", { type: "text", cls: "brewin-lan-modal-title", placeholder: "Device name (e.g. Living room TV)" });
      name.addEventListener("input", () => (this.fields.title = name.value));
      window.setTimeout(() => name.focus(), 0);
    }

    let portsSetting: Setting | null = null;
    let managedSetting: Setting | null = null;
    const syncPorts = (): void => {
      const hosts = this.types.find((t) => t.id === this.fields.type)?.hosts ?? false;
      portsSetting?.settingEl.toggleClass("brewin-lan-hidden", !hosts);
      // "Managed?" is only a question for the kinds of device where it changes what they can do.
      managedSetting?.settingEl.toggleClass("brewin-lan-hidden", !isManageable(this.fields.type, this.types));
    };

    new Setting(contentEl).setName("Type").addDropdown((d) => {
      this.types.forEach((t) => d.addOption(t.id, t.label));
      d.setValue(this.fields.type).onChange((v) => {
        this.fields.type = v;
        const type = this.types.find((t) => t.id === v);
        if (type?.defaultPorts && this.fields.ports === null) this.fields.ports = type.defaultPorts;
        if (!isManageable(v, this.types)) this.fields.managed = null;
        syncPorts();
      });
    });

    managedSetting = new Setting(contentEl)
      .setName("Managed?")
      .setDesc("An unmanaged switch cannot tag a frame, so it cannot carry a VLAN — which is worth knowing before planning one.")
      .addDropdown((d) =>
        d
          .addOption("", "— not recorded —")
          .addOption("true", "Managed (web UI, CLI or SNMP)")
          .addOption("false", "Unmanaged")
          .setValue(this.fields.managed === null ? "" : String(this.fields.managed))
          .onChange((v) => (this.fields.managed = v === "" ? null : v === "true"))
      );

    new Setting(contentEl).setName("Status").addDropdown((d) => {
      STATUSES.forEach((s) => d.addOption(s, s));
      d.setValue(this.fields.status).onChange((v) => (this.fields.status = v as DeviceStatus));
    });

    // ── Addressing ───────────────────────────────────────────────────────────
    let ipInput: HTMLInputElement | null = null;
    new Setting(contentEl)
      .setName("Segment")
      .setDesc("Which VLAN or subnet it lives on. Picking one offers the next free address.")
      .addDropdown((d) => {
        d.addOption("", "— none —");
        this.net.segments.forEach((s) => d.addOption(segmentKey(s), segmentLabel(s)));
        d.setValue(this.segment ? segmentKey(this.segment) : "").onChange((v) => {
          this.segment = this.net.segments.find((s) => segmentKey(s) === v) ?? null;
          this.fields.vlan = this.segment?.vlanId ?? null;
          this.fields.prefix = this.segment?.cidr?.prefix ?? this.fields.prefix;
          if (this.segment && ipInput && !ipInput.value) {
            const free = nextFreeIn(this.net, this.segment, { avoidPool: this.fields.assign !== "dhcp" });
            if (free) {
              ipInput.value = free;
              this.fields.ip = free;
            }
          }
        });
      });

    new Setting(contentEl)
      .setName("IPv4 address")
      .setDesc("With or without a prefix — the segment's is used when you leave it off.")
      .addText((t) => {
        ipInput = t.inputEl;
        t.setPlaceholder("192.168.0.51").setValue(this.fields.ip).onChange((v) => (this.fields.ip = v.trim()));
      })
      .addExtraButton((b) =>
        b
          .setIcon("wand")
          .setTooltip("Next free address in this segment")
          .onClick(() => {
            if (!this.segment) {
              new Notice("Pick a segment first.");
              return;
            }
            const free = nextFreeIn(this.net, this.segment, { avoidPool: this.fields.assign !== "dhcp" });
            if (!free) {
              new Notice("No free address left in that segment.");
              return;
            }
            this.fields.ip = free;
            if (ipInput) ipInput.value = free;
          })
      );

    new Setting(contentEl)
      .setName("Assignment")
      .setDesc("Static addresses are kept out of the DHCP pool when suggesting one.")
      .addDropdown((d) =>
        d
          .addOption("", "— unspecified —")
          .addOption("static", "Static")
          .addOption("dhcp", "DHCP")
          .addOption("reserved", "DHCP reservation")
          .setValue(this.fields.assign)
          .onChange((v) => (this.fields.assign = v))
      );

    new Setting(contentEl)
      .setName("MAC")
      .setDesc("Needed for a DHCP reservation, and for matching the device on the wire.")
      .addText((t) => t.setPlaceholder("2c:cf:67:5b:70:26").setValue(this.fields.mac).onChange((v) => (this.fields.mac = v.trim())));

    // ── Where it plugs in ────────────────────────────────────────────────────
    //
    // A link has two ends and both are worth recording: the port it lands on at the far end, and
    // the port it leaves from here. Tracing a cable needs both, and the near port is occupied on
    // this device whether or not anything else knows about it.
    const hostsList = this.net.devices.filter((d) => this.types.find((t) => t.id === d.type)?.hosts && d.path !== this.editing?.path);
    let portsRow: Setting | null = null;
    const describePorts = (): void => {
      const uplink = this.fields.uplink;
      portsRow?.setName(uplink ? `Ports on the link to ${uplink}` : "Ports on the link");
      portsRow?.setDesc(
        uplink
          ? `Which port at ${uplink}'s end, and which port at this device's end. Leave either blank if it is wireless or unknown.`
          : "Pick an uplink first."
      );
      portsRow?.settingEl.toggleClass("brewin-lan-hidden", !uplink);
    };

    new Setting(contentEl)
      .setName("Uplink")
      .setDesc("The switch, router or AP it connects to — this is what draws the topology.")
      .addDropdown((d) => {
        d.addOption("", "— none —");
        hostsList.forEach((h) => d.addOption(h.title, h.title));
        d.setValue(this.fields.uplink ?? "").onChange((v) => {
          this.fields.uplink = v || null;
          describePorts();
        });
      });

    portsRow = new Setting(contentEl)
      .addText((t) =>
        t
          .setPlaceholder("their port")
          .setValue(this.fields.uplinkPort === null ? "" : String(this.fields.uplinkPort))
          .onChange((v) => (this.fields.uplinkPort = v.trim() === "" ? null : Number(v) || null))
      )
      .addText((t) =>
        t
          .setPlaceholder("our port")
          .setValue(this.fields.localPort === null ? "" : String(this.fields.localPort))
          .onChange((v) => (this.fields.localPort = v.trim() === "" ? null : Number(v) || null))
      );
    describePorts();

    portsSetting = new Setting(contentEl)
      .setName("Ports on this device")
      .setDesc("How many things can plug into it.")
      .addText((t) =>
        t
          .setPlaceholder("8")
          .setValue(this.fields.ports === null ? "" : String(this.fields.ports))
          .onChange((v) => (this.fields.ports = v.trim() === "" ? null : Number(v) || null))
      );
    syncPorts();

    new Setting(contentEl).setName("Location").addText((t) => t.setValue(this.fields.location).onChange((v) => (this.fields.location = v.trim())));

    const buttons = contentEl.createDiv({ cls: "brewin-lan-modal-buttons" });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    buttons.createEl("button", { text: this.editing ? "Save" : "Create device", cls: "mod-cta" }).addEventListener("click", () => void this.save());
  }

  private addressText(): string {
    if (!this.fields.ip) return "";
    const parsed = parseAddress(this.fields.ip);
    if (!parsed) return this.fields.ip;
    const prefix = parsed.prefix ?? this.fields.prefix ?? this.segment?.cidr?.prefix ?? null;
    return prefix === null ? parsed.ip : `${parsed.ip}/${prefix}`;
  }

  private async save(): Promise<void> {
    const title = this.fields.title.trim();
    if (!this.editing && !title) {
      new Notice("A device needs a name.");
      return;
    }
    if (this.fields.ip && !parseAddress(this.fields.ip)) {
      new Notice(`"${this.fields.ip}" is not an IPv4 address.`);
      return;
    }
    if (this.fields.mac && !normaliseMac(this.fields.mac)) {
      new Notice(`"${this.fields.mac}" is not a MAC address.`);
      return;
    }

    if (this.editing) {
      const device = this.editing;
      await this.store.setType(device, this.fields.type);
      await this.store.setStatus(device, this.fields.status);
      if (this.fields.ip) await this.store.setAddress(device, this.addressText());
      await this.store.setMac(device, normaliseMac(this.fields.mac) ?? "");
      await this.store.setVlan(device, this.fields.vlan);
      await this.store.setAssignment(device, this.fields.assign);
      await this.store.setUplink(device, this.fields.uplink, this.fields.uplinkPort, this.fields.localPort);
      await this.store.setManaged(device, this.fields.managed);
      new Notice(`${device.title} updated.`);
    } else {
      const parsed = this.fields.ip ? parseAddress(this.fields.ip) : null;
      await this.store.createDevice({
        ...this.fields,
        title,
        ip: parsed?.ip ?? "",
        prefix: parsed?.prefix ?? this.fields.prefix ?? this.segment?.cidr?.prefix ?? null,
        mac: normaliseMac(this.fields.mac) ?? "",
      });
      new Notice(`Device created: ${title}`);
    }
    this.onDone();
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

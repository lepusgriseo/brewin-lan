import { App, Modal, Notice, Setting } from "obsidian";
import { LanStore } from "./lanStore";
import {
  formatPortList,
  formatSpeeds,
  parsePortList,
  parseSpeeds,
  PortMedium,
  resolvePort,
} from "./ports";
import { Device } from "./types";

const CONNECTORS = ["RJ45", "SFP", "SFP+", "SFP28", "QSFP+", "LC", "SC", "DAC"];

/**
 * Edit one port, or a range of them.
 *
 * Split the way the data is: **hardware** (what the port is made of) applies to every port named
 * and is written as a range, because that is how a switch is specified; **configuration** (access
 * or trunk, which VLAN) is written per port. Leaving a field alone leaves it as it was; emptying
 * one clears it.
 */
export class PortModal extends Modal {
  private ports: number[];
  private medium: PortMedium | null;
  private connector: string;
  private speeds: string;
  private poe: boolean | null;
  private hardwareLabel: string;

  private mode: "access" | "trunk" | null;
  private vlan: number | null;
  private allowed: string;
  private configLabel: string;

  constructor(app: App, private store: LanStore, private device: Device, port: number, private onDone: () => void) {
    super(app);
    const resolved = resolvePort(device, port);
    const group = device.portGroups.find((g) => g.ports.includes(port));
    // Editing a port that shares a group opens on the whole group: changing "the 2.5G ports" is
    // the common intent, and narrowing it is one edit of the field.
    this.ports = group ? [...group.ports] : [port];
    this.medium = group?.medium ?? resolved.medium;
    this.connector = group?.connector ?? resolved.connector ?? "";
    this.speeds = formatSpeeds(group?.speeds ?? resolved.speeds);
    this.poe = group?.poe ?? (device.poePorts.includes(port) ? true : null);
    this.hardwareLabel = group?.label ?? "";

    const config = device.portConfig.find((c) => c.port === port);
    this.mode = config?.mode ?? null;
    this.vlan = config?.vlan ?? null;
    this.allowed = (config?.allowed ?? []).join(", ");
    this.configLabel = config?.label ?? "";
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("brewin-lan-modal");
    contentEl.createEl("h3", { text: `Ports on ${this.device.title}` });

    new Setting(contentEl)
      .setName("Ports")
      .setDesc("One port, a range like 1-8, or a list like 1,3,5. The hardware below applies to all of them.")
      .addText((t) =>
        t.setValue(formatPortList(this.ports)).onChange((v) => {
          this.ports = parsePortList(v);
        })
      );

    contentEl.createEl("h4", { text: "Hardware" });
    new Setting(contentEl)
      .setName("Presentation")
      .setDesc("Electrical or optical. An SFP cage is read as optical unless you say otherwise — a direct-attach copper cable in one is electrical.")
      .addDropdown((d) =>
        d
          .addOption("", "— not recorded —")
          .addOption("copper", "Electrical (copper)")
          .addOption("fibre", "Optical (fibre)")
          .setValue(this.medium ?? "")
          .onChange((v) => (this.medium = v === "" ? null : (v as PortMedium)))
      );

    new Setting(contentEl)
      .setName("Connector")
      .setDesc(CONNECTORS.join(" · "))
      .addText((t) => t.setPlaceholder("RJ45").setValue(this.connector).onChange((v) => (this.connector = v.trim())));

    new Setting(contentEl)
      .setName("Capable speeds")
      .setDesc("What the port can negotiate: 2.5G, 1/2.5/5/10G, or the classic 10/100/1000. Copper is assumed to fall back down the BASE-T ladder, so the top speed alone is usually enough.")
      .addText((t) => t.setPlaceholder("1/2.5G").setValue(this.speeds).onChange((v) => (this.speeds = v.trim())));

    new Setting(contentEl)
      .setName("PoE")
      .addDropdown((d) =>
        d
          .addOption("", "— not recorded —")
          .addOption("true", "Supplies power")
          .addOption("false", "No power")
          .setValue(this.poe === null ? "" : String(this.poe))
          .onChange((v) => (this.poe = v === "" ? null : v === "true"))
      );

    new Setting(contentEl)
      .setName("Hardware label")
      .addText((t) => t.setPlaceholder("front panel, left bank…").setValue(this.hardwareLabel).onChange((v) => (this.hardwareLabel = v.trim())));

    contentEl.createEl("h4", { text: "Configuration" });
    contentEl.createEl("p", { cls: "setting-item-description", text: "Written per port. Leave everything here empty to remove a port's configuration." });

    new Setting(contentEl).setName("Mode").addDropdown((d) =>
      d
        .addOption("", "— not recorded —")
        .addOption("access", "Access")
        .addOption("trunk", "Trunk")
        .setValue(this.mode ?? "")
        .onChange((v) => (this.mode = v === "" ? null : (v as "access" | "trunk")))
    );

    new Setting(contentEl)
      .setName("VLAN")
      .setDesc("The access VLAN, or a trunk's native VLAN.")
      .addText((t) =>
        t
          .setPlaceholder("20")
          .setValue(this.vlan === null ? "" : String(this.vlan))
          .onChange((v) => (this.vlan = v.trim() === "" ? null : Number(v) || null))
      );

    new Setting(contentEl)
      .setName("Allowed VLANs")
      .setDesc("Trunks only. Empty means all.")
      .addText((t) => t.setPlaceholder("1, 20, 30").setValue(this.allowed).onChange((v) => (this.allowed = v)));

    new Setting(contentEl)
      .setName("Port label")
      .addText((t) => t.setPlaceholder("to the office switch").setValue(this.configLabel).onChange((v) => (this.configLabel = v.trim())));

    const buttons = contentEl.createDiv({ cls: "brewin-lan-modal-buttons" });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    buttons.createEl("button", { text: "Save", cls: "mod-cta" }).addEventListener("click", () => void this.save());
  }

  private async save(): Promise<void> {
    if (this.ports.length === 0) {
      new Notice("Name at least one port — 9, 1-8, or 1,3,5.");
      return;
    }
    const speeds = parseSpeeds(this.speeds);
    if (this.speeds && speeds.length === 0) {
      new Notice(`"${this.speeds}" is not a speed. Try 2.5G, 10G, or 10/100/1000.`);
      return;
    }
    await this.store.setPortHardware(this.device, this.ports, {
      medium: this.medium,
      connector: this.connector || null,
      speeds,
      poe: this.poe,
      label: this.hardwareLabel || null,
    });
    await this.store.setPortSetup(this.device, this.ports, {
      mode: this.mode,
      vlan: this.vlan,
      allowed: this.allowed
        .split(/[,\s]+/)
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n) && n > 0),
      label: this.configLabel || null,
    });
    new Notice(`${this.device.title}: port${this.ports.length === 1 ? "" : "s"} ${formatPortList(this.ports)} updated.`);
    this.onDone();
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

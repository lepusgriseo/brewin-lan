import { App, PluginSettingTab, Setting } from "obsidian";
import type BrewinLanPlugin from "./main";
import { LayoutMode } from "./topology";
import { BrewinLanSettings, DEFAULT_SETTINGS, migrateSettings } from "./settingsData";

export { DEFAULT_SETTINGS, SETTINGS_VERSION, migrateSettings } from "./settingsData";
export type { BrewinLanSettings } from "./settingsData";

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export class BrewinLanSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: BrewinLanPlugin) {
    super(app, plugin);
  }

  private text(name: string, desc: string, key: "deviceTag" | "segmentTag" | "devicesFolder" | "segmentsFolder" | "hubNote" | "lanDomain", placeholder = ""): void {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((t) =>
        t
          .setPlaceholder(placeholder)
          .setValue(this.plugin.settings[key])
          .onChange(async (v) => {
            this.plugin.settings[key] = v.trim();
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          })
      );
  }

  private slider(name: string, desc: string, key: "nodeSpacing" | "levelSpacing", min: number, max: number): void {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addSlider((s) =>
        s
          .setLimits(min, max, 10)
          .setValue(this.plugin.settings[key])
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings[key] = v;
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          })
      );
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Brewin LAN" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "The network lives in notes: one per device, one per VLAN or subnet. Nothing is stored in " +
        "the plugin — it reads frontmatter, and writes it back when you assign an address or a port.",
    });

    containerEl.createEl("h3", { text: "Where the notes are" });
    this.text("Device tag", "A note with this tag is a device. Nested tags count, so Network/Device/Static works too.", "deviceTag", "Network/Device");
    this.text("Segment tag", "A note with this tag is a VLAN or a plain subnet.", "segmentTag", "Network/VLAN");
    this.text(
      "Devices folder",
      "Where new device notes are created. Notes already here count as devices if they carry an ip, mac or device field, tag or no tag.",
      "devicesFolder"
    );
    this.text("Segments folder", "Where new VLAN/subnet notes are created.", "segmentsFolder");
    this.text("Hub note", "What new notes point `up:` at.", "hubNote");

    containerEl.createEl("h3", { text: "Diagram" });
    new Setting(containerEl)
      .setName("Default layout")
      .setDesc("The spine as a tree, or one band per VLAN. Both are switchable in the view.")
      .addDropdown((d) =>
        d
          .addOption("tree", "Tree — internet down to the leaves")
          .addOption("vlan", "VLAN bands — one row per segment")
          .setValue(this.plugin.settings.layoutMode)
          .onChange(async (v) => {
            this.plugin.settings.layoutMode = v as LayoutMode;
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          })
      );
    this.slider("Device spacing", "Horizontal gap between devices.", "nodeSpacing", 60, 400);
    this.slider("Level spacing", "Vertical gap between tree levels or VLAN bands.", "levelSpacing", 60, 400);
    new Setting(containerEl)
      .setName("Draw the internet")
      .setDesc("Adds a cloud above the routers, so the diagram starts where the line comes in.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showInternet).onChange(async (v) => {
          this.plugin.settings.showInternet = v;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );
    new Setting(containerEl)
      .setName("Include retired kit")
      .setDesc("Off by default: a retired device's old address is documentation, not a clash with the thing that replaced it.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.includeRetired).onChange(async (v) => {
          this.plugin.settings.includeRetired = v;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );

    containerEl.createEl("h3", { text: "Addresses and exports" });
    this.text("Local domain", "Names are qualified with this in the hosts and dnsmasq exports.", "lanDomain", "rasputin.lan");
    new Setting(containerEl)
      .setName("Largest grid drawn")
      .setDesc("A subnet with more addresses than this is listed rather than drawn cell by cell.")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.maxGridCells)).onChange(async (v) => {
          this.plugin.settings.maxGridCells = clamp(Number(v), 64, 8192, DEFAULT_SETTINGS.maxGridCells);
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );

    containerEl.createEl("h3", { text: "Device types" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Each type carries an icon and whether other devices can plug into it — the ones that can " +
        "form the spine of the topology. Icon names are Lucide's, the same set Obsidian uses.",
    });

    const list = containerEl.createDiv({ cls: "brewin-lan-typelist" });
    const redraw = () => {
      list.empty();
      this.plugin.settings.deviceTypes.forEach((type, index) => {
        const row = new Setting(list).setName(type.label).setDesc(`id: ${type.id}`);
        row.addText((t) =>
          t
            .setPlaceholder("icon")
            .setValue(type.icon)
            .onChange(async (v) => {
              this.plugin.settings.deviceTypes[index].icon = v.trim() || "circle-dot";
              await this.plugin.saveSettings();
              this.plugin.refreshViews();
            })
        );
        row.addToggle((t) =>
          t
            .setTooltip("Other devices can plug into this")
            .setValue(type.hosts)
            .onChange(async (v) => {
              this.plugin.settings.deviceTypes[index].hosts = v;
              await this.plugin.saveSettings();
              this.plugin.refreshViews();
            })
        );
        row.addExtraButton((b) =>
          b
            .setIcon("trash")
            .setTooltip("Remove this type")
            .onClick(async () => {
              this.plugin.settings.deviceTypes.splice(index, 1);
              await this.plugin.saveSettings();
              this.plugin.refreshViews();
              redraw();
            })
        );
      });
    };
    redraw();

    new Setting(containerEl)
      .setName("Add a type")
      .setDesc("An id, a label and a Lucide icon — e.g. `projector`, Projector, projector.")
      .addText((t) => t.setPlaceholder("id").then((c) => (this.newId = c.inputEl)))
      .addText((t) => t.setPlaceholder("label").then((c) => (this.newLabel = c.inputEl)))
      .addText((t) => t.setPlaceholder("icon").then((c) => (this.newIcon = c.inputEl)))
      .addButton((b) =>
        b.setButtonText("Add").onClick(async () => {
          const id = (this.newId?.value ?? "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-");
          if (!id || this.plugin.settings.deviceTypes.some((t) => t.id === id)) return;
          this.plugin.settings.deviceTypes.push({
            id,
            label: (this.newLabel?.value ?? "").trim() || id,
            icon: (this.newIcon?.value ?? "").trim() || "circle-dot",
            hosts: false,
          });
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
          redraw();
          if (this.newId) this.newId.value = "";
          if (this.newLabel) this.newLabel.value = "";
          if (this.newIcon) this.newIcon.value = "";
        })
      );

    new Setting(containerEl)
      .setName("Restore the shipped types")
      .setDesc("Puts back every default type, keeping any you have added.")
      .addButton((b) =>
        b.setButtonText("Restore").onClick(async () => {
          this.plugin.settings.deviceTypes = migrateSettings({ ...this.plugin.settings, deviceTypes: [] }).deviceTypes;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
          redraw();
        })
      );
  }

  private newId: HTMLInputElement | null = null;
  private newLabel: HTMLInputElement | null = null;
  private newIcon: HTMLInputElement | null = null;
}

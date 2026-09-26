import { Notice, Plugin, TAbstractFile, WorkspaceLeaf } from "obsidian";
import { BrewinLanSettings, BrewinLanSettingTab, migrateSettings } from "./settings";
import { LanStore } from "./lanStore";
import { LAN_VIEW_TYPE, LanView } from "./lanView";
import { DeviceModal } from "./deviceModal";
import { SegmentModal } from "./segmentModal";
import { findIssues, countBySeverity } from "./health";

export default class BrewinLanPlugin extends Plugin {
  settings!: BrewinLanSettings;
  store!: LanStore;
  private refreshQueued = false;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.store = new LanStore(this.app, this.settings);

    this.registerView(LAN_VIEW_TYPE, (leaf: WorkspaceLeaf) => new LanView(leaf, this));
    this.addRibbonIcon("network", "Brewin: LAN", () => void this.activate());

    this.addCommand({ id: "brewin-lan-open", name: "Open LAN", callback: () => void this.activate() });
    this.addCommand({
      id: "brewin-lan-new-device",
      name: "New device",
      callback: () => new DeviceModal(this.app, this.store, this.store.network(), this.settings.deviceTypes, () => this.refreshViews()).open(),
    });
    this.addCommand({
      id: "brewin-lan-new-segment",
      name: "New VLAN or subnet",
      callback: () => new SegmentModal(this.app, this.store, () => this.refreshViews()).open(),
    });
    this.addCommand({
      id: "brewin-lan-check",
      name: "Check the network",
      callback: () => {
        const issues = findIssues(this.store.network(), { types: this.settings.deviceTypes, includeRetired: this.settings.includeRetired });
        const { error, warn, info } = countBySeverity(issues);
        new Notice(
          error + warn === 0
            ? `LAN: nothing contradictory. ${info} gap${info === 1 ? "" : "s"} noted.`
            : `LAN: ${error} contradiction${error === 1 ? "" : "s"}, ${warn} disagreement${warn === 1 ? "" : "s"}, ${info} gap${info === 1 ? "" : "s"}.`
        );
        void this.activate();
      },
    });
    this.addCommand({
      id: "brewin-lan-adopt",
      name: "Mark this note as a device",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const ok = !!file && file.extension === "md";
        if (ok && !checking) {
          void this.store.adoptNote(file!.path).then(() => {
            new Notice(`${file!.basename} is now a ${this.settings.deviceTag}.`);
            this.refreshViews();
          });
        }
        return ok;
      },
    });

    this.addSettingTab(new BrewinLanSettingTab(this.app, this));

    // A device or segment note edited anywhere should move the diagram.
    const onChange = (_file: TAbstractFile) => this.queueRefresh();
    this.registerEvent(this.app.metadataCache.on("changed", onChange));
    this.registerEvent(this.app.vault.on("create", onChange));
    this.registerEvent(this.app.vault.on("delete", onChange));
    this.registerEvent(this.app.vault.on("rename", onChange));
  }

  onunload(): void {
    // Leaves are cleaned up by Obsidian; the plugin holds nothing else.
  }

  async activate(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(LAN_VIEW_TYPE)[0];
    if (!leaf) {
      // The topology wants the width, so this opens in the main area rather than the sidebar.
      leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: LAN_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(LAN_VIEW_TYPE)) {
      if (leaf.view instanceof LanView) leaf.view.render();
    }
  }

  /** Coalesced, because a single edit in Obsidian fires several cache events. */
  private queueRefresh(): void {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    window.setTimeout(() => {
      this.refreshQueued = false;
      this.refreshViews();
    }, 300);
  }

  async loadSettings(): Promise<void> {
    this.settings = migrateSettings(await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    // The store holds the settings object by reference, so nothing needs rebuilding here.
  }
}

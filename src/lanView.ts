import { ItemView, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import { findIssues, countBySeverity } from "./health";
import { DeviceModal } from "./deviceModal";
import { SegmentModal } from "./segmentModal";
import { renderTopology, TopoState } from "./topologyTab";
import { renderDevices, DeviceFilters, DEFAULT_FILTERS } from "./devicesTab";
import { renderAddresses, AddressState } from "./addressesTab";
import { renderHealth } from "./healthTab";
import { renderExport, ExportState } from "./exportTab";
import { colourFor, ViewContext } from "./viewContext";
import type BrewinLanPlugin from "./main";
import { Issue, Segment } from "./types";

export const LAN_VIEW_TYPE = "brewin-lan";

type Tab = "topology" | "devices" | "addresses" | "health" | "export";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "topology", label: "Topology", icon: "git-fork" },
  { id: "devices", label: "Devices", icon: "list" },
  { id: "addresses", label: "Addresses", icon: "layout-grid" },
  { id: "health", label: "Health", icon: "stethoscope" },
  { id: "export", label: "Export", icon: "file-down" },
];

export class LanView extends ItemView {
  private tab: Tab = "topology";
  /** Kept across renders, so a vault change doesn't move the diagram or lose a filter. */
  private topo: TopoState;
  private filters: DeviceFilters = { ...DEFAULT_FILTERS };
  private addresses: AddressState = { segment: null };
  private exportState: ExportState;

  constructor(leaf: WorkspaceLeaf, private plugin: BrewinLanPlugin) {
    super(leaf);
    this.topo = { mode: plugin.settings.layoutMode, pan: { x: 0, y: 0 }, zoom: 1, selected: null, highlight: null, fitted: false };
    this.exportState = { format: plugin.settings.lastExport, includePlanned: false };
  }

  getViewType(): string {
    return LAN_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "LAN";
  }
  getIcon(): string {
    return "network";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  /** Show a device on the diagram — used by every "◎" and cross-link in the other tabs. */
  focus(path: string): void {
    this.topo.selected = path;
    this.tab = "topology";
    this.render();
  }

  private context(): ViewContext {
    const net = this.plugin.store.network();
    const issues = findIssues(net, { types: this.plugin.settings.deviceTypes, includeRetired: this.plugin.settings.includeRetired });
    const byPath = new Map<string, Issue[]>();
    for (const issue of issues) {
      for (const path of [issue.path, issue.otherPath]) {
        if (!path) continue;
        byPath.set(path, [...(byPath.get(path) ?? []), issue]);
      }
    }
    return {
      app: this.app,
      store: this.plugin.store,
      settings: this.plugin.settings,
      net,
      issues,
      open: (path: string) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
      },
      focus: (path: string) => this.focus(path),
      refresh: () => this.render(),
      colourOf: (segment: Segment | null) => colourFor(net, segment),
      issuesFor: (path: string) => byPath.get(path) ?? [],
    };
  }

  render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("brewin-lan");
    const ctx = this.context();

    // ── Toolbar ────────────────────────────────────────────────────────────────
    const toolbar = root.createDiv({ cls: "brewin-lan-toolbar" });
    const tabs = toolbar.createDiv({ cls: "brewin-lan-tabs" });
    const counts = countBySeverity(ctx.issues);
    for (const tab of TABS) {
      const button = tabs.createEl("button", { cls: "brewin-lan-tab" + (this.tab === tab.id ? " is-on" : "") });
      const icon = button.createSpan({ cls: "brewin-lan-tab-icon" });
      setIcon(icon, tab.icon);
      button.createSpan({ text: tab.label });
      if (tab.id === "health" && counts.error + counts.warn > 0) {
        button.createSpan({ cls: `brewin-lan-tab-badge is-${counts.error ? "error" : "warn"}`, text: String(counts.error || counts.warn) });
      }
      if (tab.id === "devices") button.createSpan({ cls: "brewin-lan-tab-badge", text: String(ctx.net.devices.length) });
      button.addEventListener("click", () => {
        this.tab = tab.id;
        this.render();
      });
    }

    const actions = toolbar.createDiv({ cls: "brewin-lan-actions" });
    if (this.tab === "topology") {
      const mode = actions.createEl("button", { cls: "brewin-lan-chip", text: this.topo.mode === "tree" ? "Tree" : "VLAN bands" });
      mode.setAttr("aria-label", "Switch layout");
      mode.addEventListener("click", () => {
        this.topo.mode = this.topo.mode === "tree" ? "vlan" : "tree";
        this.topo.fitted = false;
        this.render();
      });
    }
    actions.createEl("button", { cls: "brewin-lan-chip", text: "＋ Device" }).addEventListener("click", () => {
      new DeviceModal(this.app, this.plugin.store, ctx.net, this.plugin.settings.deviceTypes, () => this.render()).open();
    });
    actions.createEl("button", { cls: "brewin-lan-chip", text: "＋ VLAN" }).addEventListener("click", () => {
      new SegmentModal(this.app, this.plugin.store, () => this.render()).open();
    });
    if (this.tab === "topology" && this.topo.selected) {
      const device = ctx.net.byPath.get(this.topo.selected);
      if (device) {
        actions.createEl("button", { cls: "brewin-lan-chip", text: "✎ Edit" }).addEventListener("click", () => {
          new DeviceModal(this.app, this.plugin.store, ctx.net, this.plugin.settings.deviceTypes, () => this.render(), device).open();
        });
      }
    }
    const refresh = actions.createEl("button", { cls: "brewin-lan-icon-btn", text: "⟳" });
    refresh.setAttr("aria-label", "Re-read the notes");
    refresh.addEventListener("click", () => this.render());

    // ── Body ───────────────────────────────────────────────────────────────────
    const body = root.createDiv({ cls: `brewin-lan-body is-${this.tab}` });
    switch (this.tab) {
      case "topology":
        renderTopology(body, ctx, this.topo);
        break;
      case "devices":
        renderDevices(body, ctx, this.filters);
        break;
      case "addresses":
        renderAddresses(body, ctx, this.addresses);
        break;
      case "health":
        renderHealth(body, ctx);
        break;
      case "export":
        renderExport(body, ctx, this.exportState);
        // Remembered for next time, since it is nearly always the same export wanted twice.
        if (this.plugin.settings.lastExport !== this.exportState.format) {
          this.plugin.settings.lastExport = this.exportState.format;
          void this.plugin.saveSettings();
        }
        break;
    }
  }
}

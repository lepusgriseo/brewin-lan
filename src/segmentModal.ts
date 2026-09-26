import { App, Modal, Notice, Setting } from "obsidian";
import { hostRange, intToIp, parseCidr, parseRange } from "./ip";
import { LanStore, NewSegmentFields } from "./lanStore";

/** Create a VLAN or a plain subnet. The gateway and pool are offered, not imposed. */
export class SegmentModal extends Modal {
  private fields: NewSegmentFields = { title: "", vlanId: null, cidr: "", gateway: "", pool: "", purpose: "" };

  constructor(app: App, private store: LanStore, private onDone: () => void) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("brewin-lan-modal");
    contentEl.createEl("h3", { text: "New VLAN or subnet" });

    const name = contentEl.createEl("input", { type: "text", cls: "brewin-lan-modal-title", placeholder: "Name (e.g. IoT, Guest, Sky LAN)" });
    name.addEventListener("input", () => (this.fields.title = name.value));
    window.setTimeout(() => name.focus(), 0);

    new Setting(contentEl)
      .setName("VLAN id")
      .setDesc("Leave empty for an untagged subnet — which is what a flat home network has.")
      .addText((t) => t.setPlaceholder("20").onChange((v) => (this.fields.vlanId = v.trim() === "" ? null : Number(v) || null)));

    let gatewayInput: HTMLInputElement | null = null;
    let poolInput: HTMLInputElement | null = null;

    new Setting(contentEl)
      .setName("CIDR")
      .setDesc("The subnet, e.g. 192.168.20.0/24.")
      .addText((t) =>
        t.setPlaceholder("192.168.20.0/24").onChange((v) => {
          this.fields.cidr = v.trim();
          // Offer the conventional shape once the subnet is known: gateway on the first address,
          // pool over the top half. Both stay editable — plenty of networks do it differently.
          const cidr = parseCidr(this.fields.cidr);
          if (!cidr || cidr.prefix > 30) return;
          const { start, end } = hostRange(cidr);
          if (gatewayInput && !gatewayInput.value) {
            this.fields.gateway = intToIp(start);
            gatewayInput.value = this.fields.gateway;
          }
          if (poolInput && !poolInput.value) {
            const from = Math.min(end, start + Math.floor((end - start) / 2));
            this.fields.pool = `${intToIp(from)}-${intToIp(end - 1)}`;
            poolInput.value = this.fields.pool;
          }
        })
      );

    new Setting(contentEl).setName("Gateway").addText((t) => {
      gatewayInput = t.inputEl;
      t.setPlaceholder("192.168.20.1").onChange((v) => (this.fields.gateway = v.trim()));
    });

    new Setting(contentEl)
      .setName("DHCP pool")
      .setDesc("A range the server hands out. Static addresses are kept out of it.")
      .addText((t) => {
        poolInput = t.inputEl;
        t.setPlaceholder("192.168.20.100-199").onChange((v) => (this.fields.pool = v.trim()));
      });

    new Setting(contentEl).setName("Purpose").addText((t) => t.setPlaceholder("What lives here, and what it may reach").onChange((v) => (this.fields.purpose = v.trim())));

    const buttons = contentEl.createDiv({ cls: "brewin-lan-modal-buttons" });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    buttons.createEl("button", { text: "Create", cls: "mod-cta" }).addEventListener("click", () => void this.save());
  }

  private async save(): Promise<void> {
    const title = this.fields.title.trim();
    if (!title) {
      new Notice("A segment needs a name.");
      return;
    }
    if (this.fields.cidr && !parseCidr(this.fields.cidr)) {
      new Notice(`"${this.fields.cidr}" is not a subnet.`);
      return;
    }
    if (this.fields.pool && !parseRange(this.fields.pool)) {
      new Notice(`"${this.fields.pool}" is not an address range.`);
      return;
    }
    await this.store.createSegment({ ...this.fields, title });
    new Notice(`Segment created: ${title}`);
    this.onDone();
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

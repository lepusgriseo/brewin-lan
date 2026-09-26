import { countBySeverity } from "./health";
import { ViewContext } from "./viewContext";
import { Issue } from "./types";

const HEADINGS: Record<Issue["severity"], { title: string; blurb: string }> = {
  error: { title: "Contradictions", blurb: "Two things that cannot both be true. On a healthy network this list is empty." },
  warn: { title: "Disagreements", blurb: "The documentation argues with itself, or with the addressing plan." },
  info: { title: "Gaps", blurb: "Not faults — things not written down yet, and what that costs you." },
};

/** Everything wrong with the network as documented, worst first. */
export function renderHealth(root: HTMLElement, ctx: ViewContext): void {
  const counts = countBySeverity(ctx.issues);
  const summary = root.createDiv({ cls: "brewin-lan-healthsummary" });
  const tile = (severity: Issue["severity"], n: number): void => {
    const box = summary.createDiv({ cls: `brewin-lan-healthtile is-${severity}` + (n === 0 ? " is-clear" : "") });
    box.createDiv({ cls: "brewin-lan-fact-value", text: String(n) });
    box.createDiv({ cls: "brewin-lan-fact-label", text: HEADINGS[severity].title.toLowerCase() });
  };
  tile("error", counts.error);
  tile("warn", counts.warn);
  tile("info", counts.info);

  if (ctx.issues.length === 0) {
    root.createDiv({ cls: "brewin-lan-empty", text: "Nothing to report — every address, VLAN and port agrees with every other." });
    return;
  }

  for (const severity of ["error", "warn", "info"] as const) {
    const group = ctx.issues.filter((i) => i.severity === severity);
    if (group.length === 0) continue;
    const section = root.createDiv({ cls: "brewin-lan-healthgroup" });
    const head = section.createDiv({ cls: "brewin-lan-section-head" });
    head.createSpan({ cls: `brewin-lan-dot is-${severity}` });
    head.createSpan({ cls: "brewin-lan-section-title", text: HEADINGS[severity].title });
    head.createSpan({ cls: "brewin-lan-count", text: String(group.length) });
    section.createDiv({ cls: "brewin-lan-section-blurb", text: HEADINGS[severity].blurb });

    for (const issue of group) {
      const row = section.createDiv({ cls: "brewin-lan-issue-row" });
      row.createDiv({ cls: "brewin-lan-issue-text", text: issue.message });
      const actions = row.createDiv({ cls: "brewin-lan-issue-actions" });
      actions.createSpan({ cls: "brewin-lan-code", text: issue.code });
      if (issue.path) {
        const open = actions.createEl("button", { cls: "brewin-lan-chip", text: "Open" });
        open.addEventListener("click", () => ctx.open(issue.path as string));
      }
      if (issue.otherPath && issue.otherPath !== issue.path) {
        const other = actions.createEl("button", { cls: "brewin-lan-chip", text: "Other" });
        other.addEventListener("click", () => ctx.open(issue.otherPath as string));
      }
    }
  }
}

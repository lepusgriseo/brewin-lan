import { App } from "obsidian";
import { LanStore } from "./lanStore";
import { BrewinLanSettings } from "./settings";
import { Network, segmentKey } from "./network";
import { segmentColour } from "./palette";
import { Issue, Segment } from "./types";

/** What every tab needs, assembled once per render by the view. */
export interface ViewContext {
  app: App;
  store: LanStore;
  settings: BrewinLanSettings;
  net: Network;
  issues: Issue[];
  /** Open a note in the main area. */
  open(path: string): void;
  /** Select a device and show it on the topology tab. */
  focus(path: string): void;
  /** Rebuild everything from the vault. */
  refresh(): void;
  colourOf(segment: Segment | null): string;
  /** Issues attached to one note, for the profile panel and the table's warning dots. */
  issuesFor(path: string): Issue[];
}

export function colourFor(net: Network, segment: Segment | null): string {
  if (segment === null) return segmentColour(null, 0);
  return segmentColour(segment, net.segmentIndex.get(segmentKey(segment)) ?? 0);
}

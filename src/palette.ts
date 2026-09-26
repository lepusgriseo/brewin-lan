// Colour is spent on the segment, because "which VLAN is this on" is the question a topology
// diagram should answer at a glance. Device type is carried by its icon instead, so the two never
// compete for the same channel.
//
// Eight slots, defined as CSS variables in styles.css with separate light and dark values. A
// segment note may override with `colour:`, which is passed through as a raw CSS colour — that is
// how a network with more than eight segments, or one with a house convention (guest = red),
// gets what it wants.

import { Segment } from "./types";

export const SEGMENT_SLOTS = 8;

/** Named shorthands, so a note can say `colour: amber` instead of a hex value. */
const NAMED: Record<string, string> = {
  blue: "var(--brewin-lan-seg-1)",
  teal: "var(--brewin-lan-seg-2)",
  green: "var(--brewin-lan-seg-3)",
  amber: "var(--brewin-lan-seg-4)",
  orange: "var(--brewin-lan-seg-5)",
  red: "var(--brewin-lan-seg-6)",
  purple: "var(--brewin-lan-seg-7)",
  pink: "var(--brewin-lan-seg-8)",
};

/** The colour for a segment: its own `colour:`, else the slot its position earns it. */
export function segmentColour(segment: Segment | null, index: number): string {
  if (segment === null) return "var(--text-muted)";
  const own = (segment.colour ?? "").trim().toLowerCase();
  if (own) return NAMED[own] ?? (segment.colour as string);
  return `var(--brewin-lan-seg-${(index % SEGMENT_SLOTS) + 1})`;
}

import type { RepoEntry } from "./types";

/** "path" is the grouped host/owner hierarchy; every other order is one flat list. */
export type SortOrder = "path" | "activity" | "name" | "size";

export const SORT_ORDERS: { value: SortOrder; title: string }[] = [
  { value: "path", title: "Path" },
  { value: "activity", title: "Last Activity" },
  { value: "name", title: "Name" },
  { value: "size", title: "Size" },
];

export function isSortOrder(value: unknown): value is SortOrder {
  return SORT_ORDERS.some((order) => order.value === value);
}

/**
 * Most recent sign of work on an entry: the later of the last commit and the last HEAD movement
 * (commit, checkout, pull, …); for offloaded entries, when the local copy was removed.
 */
export function lastActivityOf(entry: RepoEntry): string | undefined {
  if (entry.kind === "offloaded") return entry.offloadedAt;
  const times = [entry.lastCommitAt, entry.headMovedAt].filter((time): time is string => !!time);
  return times.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

function timeOf(iso: string | undefined): number {
  const time = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(time) ? -Infinity : time;
}

function byPath(a: RepoEntry, b: RepoEntry): number {
  return a.relativePath.localeCompare(b.relativePath);
}

/** Sorts a flat list; ties (and entries without the sort key, which go last) fall back to the path. */
export function sortEntries(entries: RepoEntry[], order: SortOrder): RepoEntry[] {
  const sorted = [...entries];
  if (order === "activity") {
    sorted.sort((a, b) => timeOf(lastActivityOf(b)) - timeOf(lastActivityOf(a)) || byPath(a, b));
  } else if (order === "name") {
    sorted.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || byPath(a, b));
  } else if (order === "size") {
    sorted.sort((a, b) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1) || byPath(a, b));
  } else {
    sorted.sort(byPath);
  }
  return sorted;
}

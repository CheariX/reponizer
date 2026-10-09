import path from "node:path";
import { HOST_TOKEN, isSafePathSegments, type Config } from "./config";
import { coerceCloneUrl, relativePathForUrl } from "./remotes";
import type { Protocol, RepoEntry } from "./types";

/** Where a repository goes: a host (folder space, aliases allowed) and the namespace below it. */
export interface RepoTarget {
  host: string;
  namespace: string;
}

// ---------------------------------------------------------------------------
// Known structures (autocompletion sources)
// ---------------------------------------------------------------------------

/**
 * Namespaces already present under the root, grouped by host segment and stripped of it:
 * `github.com/owner/repo` and `gitlab.com/group/sub/repo` yield
 * `github.com → ["owner"]` and `gitlab.com → ["group", "group/sub"]`.
 */
export function knownNamespaces(entries: RepoEntry[]): Map<string, string[]> {
  const byHost = new Map<string, Set<string>>();
  for (const entry of entries) {
    const segments = entry.group.split("/").filter((segment) => segment && segment !== ".");
    if (segments.length < 2) continue;
    const [host, ...rest] = segments;
    const namespaces = byHost.get(host) ?? new Set<string>();
    for (let i = 1; i <= rest.length; i++) namespaces.add(rest.slice(0, i).join("/"));
    byHost.set(host, namespaces);
  }
  return new Map([...byHost].map(([host, set]) => [host, [...set].sort()]));
}

/** Every host that can be offered as a target: seen under the root, aliased, or configured. */
export function targetHostOptions(entries: RepoEntry[], config: Config, aliases: Iterable<string>): string[] {
  const hosts = new Set<string>([...knownNamespaces(entries).keys(), ...config.defaultNamespaces.keys(), ...aliases]);
  return [...hosts].filter(Boolean).sort();
}

export interface TargetOption {
  value: string;
  /** Not under the root yet: typed into the search field, or preselected from the preferences. */
  isNew: boolean;
}

/**
 * Items of a searchable host/namespace dropdown that also accepts values typed into its search field.
 * Raycast's native filtering breaks once the items change while searching, so the forms turn it off
 * and filter here: known values containing the query, then the query itself when it is new, then the
 * current value. A controlled dropdown must always contain its value, and placed last it never takes
 * the highlight (and with it the Enter key) away from a match.
 */
export function targetOptions(known: string[], current: string, typed: string): TargetOption[] {
  const needle = typed.toLowerCase();
  const values = known.filter((value) => value.toLowerCase().includes(needle));
  if (typed && !values.some((value) => value.toLowerCase() === needle)) values.push(typed);
  if (!values.includes(current)) values.push(current);
  return values.map((value) => ({ value, isNew: !known.includes(value) }));
}

/** Host with the most repositories under the root — the likeliest target when nothing hints at another. */
export function primaryHost(entries: RepoEntry[]): string | undefined {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const host = entry.relativePath.split("/")[0];
    if (host) counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  let best: string | undefined;
  for (const [host, count] of counts) {
    if (!best || count > (counts.get(best) ?? 0)) best = host;
  }
  return best;
}

/**
 * Host and namespace a form starts on: the source host when it has a configured default,
 * otherwise the first configured host, otherwise the source host with an empty namespace.
 */
export function initialTarget(config: Config, sourceHost: string | undefined): RepoTarget {
  const defaults = config.defaultNamespaces;
  if (sourceHost && defaults.has(sourceHost)) {
    return { host: sourceHost, namespace: defaults.get(sourceHost) ?? "" };
  }
  const first = defaults.entries().next();
  if (!first.done) return { host: first.value[0], namespace: first.value[1] };
  return { host: sourceHost ?? "", namespace: "" };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface TargetInput extends RepoTarget {
  name: string;
  protocol: Protocol;
}

export interface PlannedTarget {
  /** Path under the root, e.g. "gitlab.com/me/sub/demo". */
  relativePath: string;
  destination: string;
  url: string;
}

/**
 * Resolve form input into the repository's URL and place under the root, or undefined when the
 * target is incomplete or unusable. Every path segment is guarded separately: coerceCloneUrl
 * only rejects a leading dash on the whole string, but "owner/-x" would still reach git argv as a flag.
 */
export function planTarget(config: Config, input: TargetInput): PlannedTarget | undefined {
  const host = input.host.trim();
  const namespace = input.namespace.trim().replace(/^\/+|\/+$/g, "");
  const name = input.name.trim().replace(/\.git$/, "");
  if (!host || !namespace || !name) return undefined;
  if (!HOST_TOKEN.test(host) || !isSafePathSegments(namespace) || !HOST_TOKEN.test(name)) return undefined;

  const url = coerceCloneUrl(`${host}/${namespace}/${name}`, input.protocol);
  if (!url) return undefined;
  const relativePath = relativePathForUrl(url);
  if (!relativePath) return undefined;
  return { relativePath, destination: path.join(config.root, relativePath), url };
}

/**
 * Why a new repository must not go to `relativePath`, judged from the index: the place is taken, it
 * lies inside another repository or offloaded placeholder, or it is deeper than the scan reaches. The
 * scan stops at the first two and never gets to the last, so the repository would drop out of the list
 * on the next rescan. Paths compare case-insensitively, like the default macOS file system.
 */
export function placementProblem(config: Config, entries: RepoEntry[], relativePath: string): string | undefined {
  const wanted = relativePath.toLowerCase();
  for (const entry of entries) {
    const existing = entry.relativePath.toLowerCase();
    if (wanted === existing) return `${entry.relativePath} already exists.`;
    if (wanted.startsWith(`${existing}/`)) return `That would be inside ${entry.relativePath}.`;
  }
  if (relativePath.split("/").length > config.maxDepth) {
    return `That is deeper than the scan depth (${config.maxDepth}) — raise “Max Scan Depth” first.`;
  }
  return undefined;
}

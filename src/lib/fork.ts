import fs from "node:fs/promises";
import path from "node:path";
import { HOST_TOKEN, isSafePathSegments, type Config } from "./config";
import { git } from "./git";
import { pruneEmptyParents, relocateRepo, type OpResult } from "./ops";
import { coerceCloneUrl, normalizeRemoteUrl, parseRemoteUrl, relativePathForUrl } from "./remotes";
import { isClean } from "./status";
import type { ForkInfo, Protocol, RemoteInfo, Repo, RepoEntry } from "./types";
import { errorMessage } from "./util";

const NETWORK_TIMEOUT = 120_000;
const CLONE_TIMEOUT = 15 * 60_000;

/** How much of the local history a fork pushes to its new origin. */
export type PushScope = "all" | "current" | "none";

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * The remote that turns a repo into a fork: the configured upstream name, parseable,
 * and pointing at a different repository than origin.
 */
export function findUpstreamRemote(
  remotes: RemoteInfo[],
  origin: RemoteInfo | undefined,
  remoteName: string,
): RemoteInfo | undefined {
  const candidate = remotes.find((remote) => remote.name === remoteName);
  if (!candidate) return undefined;
  const normalized = normalizeRemoteUrl(candidate.fetchUrl);
  if (!normalized) return undefined;
  if (origin && normalizeRemoteUrl(origin.fetchUrl) === normalized) return undefined;
  return candidate;
}

/**
 * First upstream remote-tracking ref that actually exists locally, preferring the checked-out
 * branch. Returns undefined while the upstream has never been fetched.
 */
export async function resolveUpstreamRef(
  fullPath: string,
  remoteName: string,
  branch?: string,
): Promise<string | undefined> {
  const candidates = [branch, "HEAD", "main", "master"].filter((name): name is string => Boolean(name));
  for (const name of candidates) {
    const ref = `${remoteName}/${name}`;
    try {
      await git(fullPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      return ref;
    } catch {
      // not fetched yet, or the branch does not exist upstream
    }
  }
  return undefined;
}

/** Commits HEAD is ahead of / behind `ref`, based on what was fetched last. */
export async function upstreamDivergence(
  fullPath: string,
  ref: string,
): Promise<{ ahead: number; behind: number } | undefined> {
  const output = await git(fullPath, ["rev-list", "--left-right", "--count", `HEAD...${ref}`]);
  const [ahead, behind] = output.split(/\s+/).map((value) => Number.parseInt(value, 10));
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return undefined;
  return { ahead, behind };
}

/**
 * Fork state of a repo, or undefined when it has no upstream remote. Divergence is best effort:
 * an upstream that was never fetched still yields a ForkInfo, just without ahead/behind.
 */
export async function inspectFork(
  fullPath: string,
  remotes: RemoteInfo[],
  origin: RemoteInfo | undefined,
  remoteName: string,
  branch?: string,
): Promise<ForkInfo | undefined> {
  const upstream = findUpstreamRemote(remotes, origin, remoteName);
  if (!upstream) return undefined;
  const info: ForkInfo = {
    remoteName: upstream.name,
    url: upstream.fetchUrl,
    relativePath: relativePathForUrl(upstream.fetchUrl),
  };
  const ref = await resolveUpstreamRef(fullPath, upstream.name, branch).catch(() => undefined);
  if (!ref) return info;
  info.ref = ref;
  const divergence = await upstreamDivergence(fullPath, ref).catch(() => undefined);
  if (divergence) {
    info.ahead = divergence.ahead;
    info.behind = divergence.behind;
  }
  return info;
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

/** Every host that can be offered as a fork target: seen under the root, aliased, or configured. */
export function forkHostOptions(entries: RepoEntry[], config: Config, aliases: Iterable<string>): string[] {
  const hosts = new Set<string>([
    ...knownNamespaces(entries).keys(),
    ...config.defaultForkNamespaces.keys(),
    ...aliases,
  ]);
  return [...hosts].filter(Boolean).sort();
}

export interface ForkTarget {
  host: string;
  namespace: string;
}

/**
 * Host and namespace a fork form starts on: the source host when it has a configured default,
 * otherwise the first configured host, otherwise the source host with an empty namespace.
 */
export function initialForkTarget(config: Config, sourceHost: string | undefined): ForkTarget {
  const defaults = config.defaultForkNamespaces;
  if (sourceHost && defaults.has(sourceHost)) {
    return { host: sourceHost, namespace: defaults.get(sourceHost) ?? "" };
  }
  const first = defaults.entries().next();
  if (!first.done) return { host: first.value[0], namespace: first.value[1] };
  return { host: sourceHost ?? "", namespace: "" };
}

/** Repos elsewhere under the root with the same host and repo name — likely fork sources. */
export function upstreamCandidates(repo: Repo, entries: RepoEntry[]): string[] {
  const segments = repo.relativePath.split("/");
  const host = segments[0];
  const name = segments[segments.length - 1];
  const originNormalized = repo.origin && normalizeRemoteUrl(repo.origin.fetchUrl);
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.relativePath === repo.relativePath) continue;
    const parts = entry.relativePath.split("/");
    if (parts[0] !== host || parts[parts.length - 1] !== name) continue;
    const url = entry.kind === "repo" ? entry.origin?.fetchUrl : entry.originUrl;
    if (!url) continue;
    const normalized = normalizeRemoteUrl(url);
    if (!normalized || normalized === originNormalized || seen.has(normalized)) continue;
    seen.add(normalized);
    urls.push(url);
  }
  return urls;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface ForkPlan {
  /** Path under the root the fork will live at, e.g. "gitlab.com/me/sub/demo". */
  targetRelativePath: string;
  targetDestination: string;
  targetUrl: string;
  /** Origin URL of the source repo, preserved as the upstream remote. */
  upstreamUrl?: string;
  upstreamRemoteName: string;
  /** Keep the source checkout and create the fork as a second one. */
  keepOriginal: boolean;
  pushScope: PushScope;
}

export interface ForkInput {
  host: string;
  namespace: string;
  name: string;
  protocol: Protocol;
  upstreamUrl?: string;
  keepOriginal?: boolean;
  pushScope?: PushScope;
}

/**
 * Resolve form input into a fork plan, or undefined when the target is incomplete or unusable.
 * Every path segment is guarded separately: coerceCloneUrl only rejects a leading dash on the
 * whole string, but "owner/-x" would still reach git argv as a flag.
 */
export function planFork(config: Config, input: ForkInput): ForkPlan | undefined {
  const host = input.host.trim();
  const namespace = input.namespace.trim().replace(/^\/+|\/+$/g, "");
  const name = input.name.trim().replace(/\.git$/, "");
  if (!host || !namespace || !name) return undefined;
  if (!HOST_TOKEN.test(host) || !isSafePathSegments(namespace) || !HOST_TOKEN.test(name)) return undefined;

  const targetUrl = coerceCloneUrl(`${host}/${namespace}/${name}`, input.protocol);
  if (!targetUrl) return undefined;
  const targetRelativePath = relativePathForUrl(targetUrl);
  if (!targetRelativePath) return undefined;

  return {
    targetRelativePath,
    targetDestination: path.join(config.root, targetRelativePath),
    targetUrl,
    upstreamUrl: input.upstreamUrl,
    upstreamRemoteName: config.upstreamRemoteName,
    keepOriginal: input.keepOriginal ?? false,
    pushScope: input.pushScope ?? "all",
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Push failure after the remotes were already rewired — deliberately not rolled back. */
export class ForkPushError extends Error {
  constructor(
    message: string,
    public readonly targetUrl: string,
  ) {
    super(message);
    this.name = "ForkPushError";
  }
}

/**
 * Page where the repository can be created by hand, for hosts without push-to-create.
 * GitLab and Gitea create the project on first push; GitHub does not.
 */
export function createRepoUrl(targetUrl: string): string | undefined {
  const parsed = parseRemoteUrl(targetUrl);
  if (!parsed) return undefined;
  if (parsed.host.toLowerCase() === "github.com") return "https://github.com/new";
  return `https://${parsed.host}/projects/new`;
}

async function remoteNames(fullPath: string): Promise<string[]> {
  return (await git(fullPath, ["remote"])).split("\n").filter(Boolean);
}

/** Point origin at the fork target and preserve the previous origin as the upstream remote. */
export async function rewireForFork(fullPath: string, plan: ForkPlan): Promise<void> {
  const names = await remoteNames(fullPath);
  if (plan.upstreamUrl && !names.includes(plan.upstreamRemoteName)) {
    await git(fullPath, ["remote", "add", plan.upstreamRemoteName, plan.upstreamUrl]);
  }
  if (names.includes("origin")) {
    await git(fullPath, ["remote", "set-url", "origin", plan.targetUrl]);
  } else {
    await git(fullPath, ["remote", "add", "origin", plan.targetUrl]);
  }
}

export async function pushFork(fullPath: string, scope: PushScope, targetUrl: string, branch?: string): Promise<void> {
  if (scope === "none") return;
  try {
    if (scope === "all") {
      await git(fullPath, ["push", "--set-upstream", "origin", "--all"], { timeoutMs: NETWORK_TIMEOUT });
    } else {
      if (!branch) throw new Error("no branch checked out to push");
      await git(fullPath, ["push", "--set-upstream", "origin", `HEAD:refs/heads/${branch}`], {
        timeoutMs: NETWORK_TIMEOUT,
      });
    }
    await git(fullPath, ["push", "origin", "--tags"], { timeoutMs: NETWORK_TIMEOUT });
  } catch (error) {
    throw new ForkPushError(errorMessage(error), targetUrl);
  }
}

export async function currentBranch(fullPath: string): Promise<string | undefined> {
  const name = await git(fullPath, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => undefined);
  return name && name !== "HEAD" ? name : undefined;
}

/**
 * Turn remote-tracking branches into local ones so `push --all` carries the whole repository
 * and not just the branches that happen to be checked out. Must run before origin is removed —
 * that drops the tracking refs — and a branch that already exists locally wins.
 */
export async function materializeTrackingBranches(fullPath: string, currentBranch?: string): Promise<void> {
  // Full refnames, not %(refname:short): the latter shortens refs/remotes/origin/HEAD to
  // plain "origin", which is indistinguishable from a branch actually named "origin".
  const prefix = "refs/remotes/origin/";
  const output = await git(fullPath, ["for-each-ref", "--format=%(refname)", "refs/remotes/origin"]);
  for (const ref of output.split("\n").filter(Boolean)) {
    if (!ref.startsWith(prefix)) continue;
    const name = ref.slice(prefix.length);
    if (!name || name === "HEAD" || name === currentBranch || name.startsWith("-")) continue;
    // Already existing branches are fine; anything else is not worth aborting the fork for.
    await git(fullPath, ["branch", "--track", name, ref]).catch(() => undefined);
  }
}

/**
 * Create the fork and return its absolute path. Push failures are surfaced as ForkPushError
 * with the remotes left in place, so the user can create the repository and retry.
 */
export async function executeFork(config: Config, repo: Repo, plan: ForkPlan): Promise<string> {
  const branch = repo.status && !repo.status.detached ? repo.status.branch : undefined;

  if (plan.keepOriginal) {
    await fs.mkdir(path.dirname(plan.targetDestination), { recursive: true });
    try {
      await git(path.dirname(plan.targetDestination), ["clone", "--", repo.fullPath, plan.targetDestination], {
        timeoutMs: CLONE_TIMEOUT,
      });
    } catch (error) {
      await fs.rm(plan.targetDestination, { recursive: true, force: true }).catch(() => undefined);
      await pruneEmptyParents(config.root, plan.targetDestination);
      throw error;
    }
    if (plan.pushScope === "all") await materializeTrackingBranches(plan.targetDestination, branch);
    await git(plan.targetDestination, ["remote", "remove", "origin"]);
    await rewireForFork(plan.targetDestination, plan);
    await pushFork(plan.targetDestination, plan.pushScope, plan.targetUrl, branch);
    return plan.targetDestination;
  }

  // Branches that were never checked out only exist as origin/* refs, so materialize them
  // before origin is repointed — otherwise "all branches" would silently push a subset.
  if (plan.pushScope === "all") await materializeTrackingBranches(repo.fullPath, branch);
  await rewireForFork(repo.fullPath, plan);
  await pushFork(repo.fullPath, plan.pushScope, plan.targetUrl, branch);
  return relocateRepo(config.root, repo, plan.targetRelativePath);
}

/** Push an existing fork to its origin — the retry after a push-to-create host refused. */
export async function pushToOrigin(repo: Repo, scope: PushScope = "all"): Promise<void> {
  const targetUrl = repo.origin?.fetchUrl;
  if (!targetUrl) throw new Error("No origin remote configured.");
  const branch = repo.status && !repo.status.detached ? repo.status.branch : undefined;
  await pushFork(repo.fullPath, scope, targetUrl, branch);
}

/**
 * Fast-forward the current branch onto its upstream. Like pullRepo this never merges and
 * skips anything that would need a decision.
 */
export async function syncForkRepo(repo: Repo): Promise<OpResult> {
  const base = { fullPath: repo.fullPath, relativePath: repo.relativePath };
  if (!repo.fork) return { ...base, ok: true, skipped: "no upstream remote" };
  if (!repo.status) return { ...base, ok: false, error: repo.error ?? "status unknown" };
  if (repo.status.detached) return { ...base, ok: true, skipped: "detached HEAD" };
  if (repo.status.conflicted > 0) return { ...base, ok: true, skipped: "merge conflicts" };
  if (!isClean(repo.status)) return { ...base, ok: true, skipped: "uncommitted changes" };
  try {
    await git(repo.fullPath, ["fetch", repo.fork.remoteName, "--prune"], { timeoutMs: NETWORK_TIMEOUT });
    const ref = await resolveUpstreamRef(repo.fullPath, repo.fork.remoteName, repo.status.branch);
    if (!ref) return { ...base, ok: true, skipped: "no matching upstream branch" };
    const divergence = await upstreamDivergence(repo.fullPath, ref);
    if (!divergence) return { ...base, ok: false, error: `could not compare with ${ref}` };
    if (divergence.behind === 0) return { ...base, ok: true, skipped: "already up to date" };
    if (divergence.ahead > 0) return { ...base, ok: true, skipped: `local commits ahead of ${ref}` };
    await git(repo.fullPath, ["merge", "--ff-only", ref]);
    return { ...base, ok: true };
  } catch (error) {
    return { ...base, ok: false, error: errorMessage(error) };
  }
}

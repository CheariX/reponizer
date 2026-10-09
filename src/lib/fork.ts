import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config";
import { git } from "./git";
import {
  createGitHubRepo,
  creationMethodFor,
  existingRepoError,
  forkGitHubRepo,
  gitHubRepoPath,
  isGitHubHost,
  provisionRemote,
  remoteState,
  type CreationMethod,
  type RemoteOutcome,
} from "./hosting";
import { assertRelocationTarget, pruneEmptyParents, relocateRepo, type OpResult } from "./ops";
import { normalizeRemoteUrl, parseRemoteUrl, relativePathForUrl } from "./remotes";
import { isClean } from "./status";
import { planTarget, type TargetInput } from "./targets";
import type { ForkInfo, RemoteInfo, Repo, RepoEntry, Visibility } from "./types";
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
// Fork sources
// ---------------------------------------------------------------------------

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
  /** Real host the fork lives on, e.g. "github.com" (never a folder alias). */
  remoteHost: string;
  /** Repository path of the fork on its host, e.g. "owner/name". */
  repoPath: string;
  /** Origin URL of the source repo, preserved as the upstream remote. */
  upstreamUrl?: string;
  upstreamRemoteName: string;
  /** Keep the source checkout and create the fork as a second one. */
  keepOriginal: boolean;
  method: CreationMethod;
  /** "owner/repo" of a GitHub source: the fork becomes a real GitHub fork of it (gh), not a copy. */
  gitHubForkOf?: string;
  /** Only `gh repo create` takes it; a real GitHub fork keeps the source's visibility. */
  visibility: Visibility;
  /** What is pushed right away — or, for forks created by hand, prepared for "Push to Origin". */
  pushScope: PushScope;
}

export interface ForkInput extends TargetInput {
  upstreamUrl?: string;
  keepOriginal?: boolean;
  pushScope?: PushScope;
  visibility?: Visibility;
  /** The forms' opt-in to the GitHub CLI (real fork or gh repo create); only counts on GitHub. */
  useGitHubCli?: boolean;
}

/**
 * "owner/repo" of the source when the fork becomes a real GitHub fork: the GitHub CLI opted into, both
 * sides on GitHub, and the target owner differs — GitHub never forks into the account that owns it.
 */
export function gitHubForkSource(
  host: string,
  namespace: string,
  upstreamUrl: string | undefined,
  useGitHubCli: boolean,
): string | undefined {
  if (creationMethodFor(host, useGitHubCli) !== "github-cli") return undefined;
  const source = gitHubRepoPath(upstreamUrl);
  const sourceOwner = source?.split("/")[0].toLowerCase();
  return sourceOwner && sourceOwner !== namespace.trim().toLowerCase() ? source : undefined;
}

/** Resolve form input into a fork plan, or undefined when the target is incomplete or unusable. */
export function planFork(config: Config, input: ForkInput): ForkPlan | undefined {
  const target = planTarget(config, input);
  const parsed = target && parseRemoteUrl(target.url);
  if (!target || !parsed) return undefined;
  const useGitHubCli = input.useGitHubCli ?? false;
  let method = creationMethodFor(input.host, useGitHubCli);
  // A GitHub owner is a single user or organization — there are no subgroups.
  if (isGitHubHost(input.host) && parsed.path.split("/").length !== 2) return undefined;
  const gitHubForkOf = gitHubForkSource(input.host, input.namespace, input.upstreamUrl, useGitHubCli);
  let pushScope = input.pushScope ?? "all";
  // GitHub fills a real fork with every branch and tag itself, and pushing stale local branches onto
  // them would only be rejected; local commits go up later with "Push to Origin".
  if (gitHubForkOf) pushScope = "none";
  // Created by hand, then pushed with "Push to Origin" — which carries all branches and tags.
  else if (method === "manual") pushScope = "all";
  // Pushing nothing creates nothing on a push-to-create host.
  else if (method === "push" && pushScope === "none") method = "manual";
  return {
    targetRelativePath: target.relativePath,
    targetDestination: target.destination,
    targetUrl: target.url,
    remoteHost: parsed.host.toLowerCase(),
    repoPath: parsed.path,
    upstreamUrl: input.upstreamUrl,
    upstreamRemoteName: config.upstreamRemoteName,
    keepOriginal: input.keepOriginal ?? false,
    method,
    gitHubForkOf,
    visibility: input.visibility ?? "private",
    pushScope,
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

async function remoteNames(fullPath: string): Promise<string[]> {
  return (await git(fullPath, ["remote"])).split("\n").filter(Boolean);
}

/** Point origin at the fork target and preserve the previous origin as the upstream remote. */
async function rewireForFork(fullPath: string, plan: ForkPlan): Promise<void> {
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

async function pushFork(fullPath: string, scope: PushScope, branch?: string): Promise<void> {
  if (scope === "none") return;
  if (scope === "all") {
    await git(fullPath, ["push", "--set-upstream", "origin", "--all"], { timeoutMs: NETWORK_TIMEOUT });
  } else {
    if (!branch) throw new Error("no branch checked out to push");
    await git(fullPath, ["push", "--set-upstream", "origin", `HEAD:refs/heads/${branch}`], {
      timeoutMs: NETWORK_TIMEOUT,
    });
  }
  await git(fullPath, ["push", "origin", "--tags"], { timeoutMs: NETWORK_TIMEOUT });
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
async function materializeTrackingBranches(fullPath: string, currentBranch?: string): Promise<void> {
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

/** What the checks before the local change found out; setUpFork needs one, so they cannot be skipped. */
interface ForkClaim {
  /** An empty repository already waits at the target (created by hand, say): it only needs the push. */
  remoteExists: boolean;
  /** Why the real GitHub fork could not be made (gh missing, logged out, …) — the user forks by hand. */
  gitHubForkProblem?: string;
}

/**
 * Everything that must succeed before the local copy becomes the fork, so a refusal changes nothing:
 * a target repository with commits stops the fork on every host, and a real GitHub fork is made here —
 * it needs a free name, an existing fork of the source stops the whole fork (forkGitHubRepo throws),
 * and any later step works against a fork that is known to exist.
 */
async function claimForkTarget(
  plan: ForkPlan,
  branch: string | undefined,
  onStep?: (step: string) => void,
): Promise<ForkClaim> {
  if (plan.pushScope === "current" && !branch) {
    throw new Error("No branch is checked out, so there is no current branch to push. Push all branches, or nothing.");
  }
  onStep?.(`Checking ${plan.remoteHost}…`);
  const state = await remoteState(plan.targetUrl);
  if (state === "has-history") throw existingRepoError(plan.remoteHost, plan.repoPath);
  if (!plan.gitHubForkOf) return { remoteExists: state === "empty" };
  if (state === "empty") {
    throw new Error(`${plan.remoteHost}/${plan.repoPath} already exists — a GitHub fork needs a name that is free.`);
  }
  onStep?.("Forking on GitHub…");
  return { remoteExists: false, gitHubForkProblem: await forkGitHubRepo(plan.gitHubForkOf, plan.repoPath) };
}

/**
 * Turn a local copy into the fork (branches for "all", remotes rewired) and bring it to its host.
 * `localSource` marks the copy as a clone of that checkout: its origin points at the checkout folder
 * and is removed, and the checkout's own remote-tracking branches are adopted for "all".
 */
async function setUpFork(
  fullPath: string,
  plan: ForkPlan,
  claim: ForkClaim,
  branch: string | undefined,
  onStep?: (step: string) => void,
  localSource?: string,
): Promise<RemoteOutcome> {
  // Branches that were never checked out only exist as origin/* refs, so materialize them
  // before origin is repointed or removed — otherwise "all branches" would silently push a subset.
  if (plan.pushScope === "all") {
    await materializeTrackingBranches(fullPath, branch);
    if (localSource) await adoptTrackingBranches(localSource, fullPath);
  }
  if (localSource) await git(fullPath, ["remote", "remove", "origin"]);
  await rewireForFork(fullPath, plan);
  return provisionRemote(
    // An empty repository that already exists only needs the push, whatever the host.
    claim.remoteExists ? "push" : plan.method,
    {
      // The real fork already happened in claimForkTarget; only its result is left to report.
      createOnGitHub: async () =>
        plan.gitHubForkOf ? claim.gitHubForkProblem : createGitHubRepo(plan.repoPath, plan.visibility),
      push: () => pushFork(fullPath, plan.pushScope, branch),
    },
    // A real fork is already made and pushes nothing, so its steps would only flash past.
    plan.gitHubForkOf ? undefined : onStep,
  );
}

/**
 * A clone of a local checkout only carries the checkout's own branches; the ones it merely tracks
 * (origin/* there) are missing, although their commits came along with the object store. Create them
 * as branches of the copy — a branch the checkout has itself was materialized first and wins.
 */
async function adoptTrackingBranches(checkout: string, copy: string): Promise<void> {
  const prefix = "refs/remotes/origin/";
  const output = await git(checkout, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes/origin"]);
  for (const line of output.split("\n").filter(Boolean)) {
    const [ref, commit] = line.split(" ");
    const name = ref.slice(prefix.length);
    if (!ref.startsWith(prefix) || !name || name === "HEAD" || name.startsWith("-")) continue;
    // An existing branch wins; anything else is not worth aborting the fork for, as in materialize.
    await git(copy, ["branch", name, commit]).catch(() => undefined);
  }
}

/**
 * Turn a copy made for this fork alone (a fresh clone) into the fork. When the fork is refused, the
 * copy is removed again — nothing of the user's is in it. `localSource`: see setUpFork.
 */
export async function forkFreshCopy(
  root: string,
  fullPath: string,
  plan: ForkPlan,
  branch: string | undefined,
  onStep?: (step: string) => void,
  localSource?: string,
): Promise<RemoteOutcome> {
  let claim: ForkClaim;
  try {
    claim = await claimForkTarget(plan, branch, onStep);
  } catch (error) {
    await discardCopy(root, fullPath);
    throw error;
  }
  try {
    return await setUpFork(fullPath, plan, claim, branch, onStep, localSource);
  } catch (error) {
    throw withGitHubFork(plan, claim, error);
  }
}

/**
 * A failure after the real GitHub fork was made must say that the fork exists: running the fork again
 * would be refused (it already has history), so the user needs to know to finish the local side by hand.
 */
function withGitHubFork(plan: ForkPlan, claim: ForkClaim, error: unknown): unknown {
  if (!plan.gitHubForkOf || claim.gitHubForkProblem) return error;
  return new Error(
    `The fork exists on GitHub as ${plan.repoPath}, but the local copy could not be set up: ${errorMessage(error)}`,
  );
}

async function discardCopy(root: string, fullPath: string): Promise<void> {
  // Best effort: the failure that triggered the cleanup is the error worth reporting.
  await fs.rm(fullPath, { recursive: true, force: true }).catch(() => undefined);
  await pruneEmptyParents(root, fullPath);
}

/**
 * Create the fork — the checkout moved into place, or a second copy — and bring it to its host.
 * Only a refusal or a failure before the local fork is complete throws; from then on the outcome
 * tells what is left to do, and nothing is rolled back: "Push to Origin" pushes once the repository
 * exists.
 */
export async function executeFork(
  config: Config,
  repo: Repo,
  plan: ForkPlan,
  onStep?: (step: string) => void,
): Promise<{ fullPath: string; outcome: RemoteOutcome }> {
  const branch = repo.status && !repo.status.detached ? repo.status.branch : undefined;

  if (plan.keepOriginal) {
    await fs.mkdir(path.dirname(plan.targetDestination), { recursive: true });
    try {
      await git(path.dirname(plan.targetDestination), ["clone", "--", repo.fullPath, plan.targetDestination], {
        timeoutMs: CLONE_TIMEOUT,
      });
    } catch (error) {
      await discardCopy(config.root, plan.targetDestination);
      throw error;
    }
    const outcome = await forkFreshCopy(config.root, plan.targetDestination, plan, branch, onStep, repo.fullPath);
    return { fullPath: plan.targetDestination, outcome };
  }

  // A taken target must fail before the GitHub fork exists, not after.
  await assertRelocationTarget(plan.targetDestination);
  const claim = await claimForkTarget(plan, branch, onStep);
  try {
    const fullPath = await relocateRepo(config.root, repo, plan.targetRelativePath);
    return { fullPath, outcome: await setUpFork(fullPath, plan, claim, branch, onStep) };
  } catch (error) {
    throw withGitHubFork(plan, claim, error);
  }
}

/** Push a fork to its origin once the repository exists there — also the retry after a failed push. */
export async function pushToOrigin(repo: Repo, scope: PushScope = "all"): Promise<void> {
  if (!repo.origin) throw new Error("No origin remote configured.");
  const branch = repo.status && !repo.status.detached ? repo.status.branch : undefined;
  await pushFork(repo.fullPath, scope, branch);
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

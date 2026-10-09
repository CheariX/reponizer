import os from "node:os";
import { getHostRules } from "./config";
import { git, GitError, run } from "./git";
import { parseRemoteUrl } from "./remotes";
import type { Visibility } from "./types";
import { errorMessage } from "./util";

const NETWORK_TIMEOUT = 120_000;
// `gh help exit-codes`: 4 means the command requires authentication.
const GH_EXIT_AUTH_REQUIRED = 4;

/**
 * How a new repository (created or forked) comes into being on its host. Every host — GitHub included —
 * is handled the same by default: hosts in the "Push-to-Create Hosts" preference create the repository
 * when the first push arrives, and everywhere else the user creates it on the host's website and pushes
 * afterwards ("Publish Branch", "Push to Origin"). On GitHub the forms offer an opt-in: its CLI creates
 * (or forks) the repository with the user's login, then the local copy is pushed.
 */
export type CreationMethod = "github-cli" | "push" | "manual";

function realHost(host: string): string {
  const lower = host.trim().toLowerCase();
  return getHostRules().aliasToReal.get(lower) ?? lower;
}

/** Whether a host (alias or real) is github.com: GitHub's rules apply and the GitHub CLI can be opted into. */
export function isGitHubHost(host: string): boolean {
  return realHost(host) === "github.com";
}

/** `useGitHubCli` is the forms' opt-in; it only counts on GitHub. */
export function creationMethodFor(host: string, useGitHubCli = false): CreationMethod {
  if (useGitHubCli && isGitHubHost(host)) return "github-cli";
  const rules = getHostRules();
  const real = realHost(host);
  return rules.pushToCreate.has(rules.realToAlias.get(real) ?? real) ? "push" : "manual";
}

/** "owner/repo" when the URL points at a repository on github.com, the only kind gh can fork. */
export function gitHubRepoPath(url: string | undefined): string | undefined {
  const parsed = url ? parseRemoteUrl(url) : undefined;
  return parsed && isGitHubHost(parsed.host) ? parsed.path : undefined;
}

// ---------------------------------------------------------------------------
// Bringing a local copy to its host
// ---------------------------------------------------------------------------

export type RemoteOutcome =
  /** The repository exists on the host with everything that was meant to be pushed. */
  | { state: "published" }
  /** The GitHub CLI created the repository, but the push failed — a plain push retries it. */
  | { state: "push-failed"; error: unknown }
  /**
   * The repository does not exist on the host (as far as Reponizer knows): the user creates it there,
   * then pushes. `problem` says what failed on the way, `error` carries the details to copy.
   */
  | { state: "needs-remote"; problem?: string; error?: unknown };

/**
 * Bring a local copy whose origin already points at the new repository to its host. Never throws:
 * the local copy is ready either way, and every failure ends in an outcome the user can act on.
 */
export async function provisionRemote(
  method: CreationMethod,
  steps: {
    /** Create the repository with the GitHub CLI; resolves to why that failed, or undefined. */
    createOnGitHub: () => Promise<string | undefined>;
    push: () => Promise<void>;
  },
  onStep?: (step: string) => void,
): Promise<RemoteOutcome> {
  if (method === "manual") return { state: "needs-remote" };

  if (method === "github-cli") {
    onStep?.("Creating the repository on GitHub…");
    const problem = await steps.createOnGitHub();
    if (problem) return { state: "needs-remote", problem };
  }

  onStep?.("Pushing…");
  try {
    await steps.push();
    return { state: "published" };
  } catch (error) {
    // After gh the repository exists and only the push is left; a refused push-to-create created nothing.
    if (method === "github-cli") return { state: "push-failed", error };
    return { state: "needs-remote", problem: pushFailureReason(error), error };
  }
}

/** What is at the new repository's URL before anything is created there. */
export type RemoteState =
  /** Nothing, or nothing Reponizer can see: the lookup failed (not found, no access, unreachable). */
  | "missing"
  /** A repository without commits, e.g. one the user created by hand: it only needs the push. */
  | "empty"
  /** A repository with commits: never create into it, a push would land next to what is there. */
  | "has-history";

/**
 * Look at the new repository's URL before anything is created — for every host, since an existing
 * repository must stop a create or fork wherever it lives. A failing lookup counts as "missing": for a
 * new repository that almost always is the reason, and any later step that fails reports its own.
 */
export async function remoteState(url: string): Promise<RemoteState> {
  let refs: string;
  try {
    // Not from the repos root: before the first repository exists that folder may not, and a lookup
    // that fails for that reason would count as "missing" and skip the check.
    refs = await git(os.tmpdir(), ["ls-remote", "--", url], { timeoutMs: NETWORK_TIMEOUT });
  } catch {
    return "missing";
  }
  return refs.trim() ? "has-history" : "empty";
}

/** The error that stops a create or fork whose repository already has commits on the host. */
export function existingRepoError(remoteHost: string, repoPath: string): Error {
  return new Error(`${remoteHost}/${repoPath} already exists and is not empty.`);
}

/**
 * Hosts explain a refused push-to-create (no permission, feature disabled) in "remote:" lines, which
 * git follows with a generic "Could not read from remote repository" — prefer the explanation.
 */
function pushFailureReason(error: unknown): string {
  if (!(error instanceof GitError)) return errorMessage(error);
  const lines = error.stderr
    .split("\n")
    .filter((line) => line.startsWith("remote:"))
    .map((line) => line.slice("remote:".length).trim())
    .filter((line) => line && !/^[=*-]+$/.test(line));
  return lines.length > 0 ? `git push: ${lines.join(" ")}` : errorMessage(error);
}

// ---------------------------------------------------------------------------
// GitHub CLI
// ---------------------------------------------------------------------------

/** Run gh with the user's login; failures become a one-line explanation. */
async function gh(args: string[]): Promise<string> {
  try {
    return (await run("gh", args, { timeoutMs: NETWORK_TIMEOUT })).stdout.trim();
  } catch (error) {
    const err = error as { code?: string | number; stderr?: string; killed?: boolean; message: string };
    if (err.code === "ENOENT") throw new Error("The GitHub CLI (gh) was not found.");
    if (err.code === GH_EXIT_AUTH_REQUIRED) throw new Error("The GitHub CLI is not logged in — run “gh auth login”.");
    // gh reports in a line or two (e.g. "HTTP 401: Bad credentials …" plus a hint), all of it relevant.
    const stderr = (err.stderr ?? "")
      .trim()
      .split(/\s*\n\s*/)
      .join(" ");
    throw new Error(`gh ${args.slice(0, 2).join(" ")}: ${err.killed ? "timed out" : stderr || err.message}`);
  }
}

/** `gh repo create`; resolves to why it failed, or undefined once the repository exists. */
export async function createGitHubRepo(repoPath: string, visibility: Visibility): Promise<string | undefined> {
  try {
    await gh(["repo", "create", repoPath, `--${visibility}`]);
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}

// A fork created longer ago than this already existed (the threshold gh itself uses).
const FRESH_FORK_MS = 60_000;

/**
 * Fork `sourcePath` on GitHub into `targetPath` ("owner/name"). Resolves to undefined once the new
 * fork exists, or to why gh could not fork (not found, logged out, …) — then the user forks by hand.
 * Throws when the fork must not go ahead at all: GitHub keeps one fork of a repository per account
 * and hands back the existing one instead of failing, so an existing fork (or one that landed under
 * another name) is an error, never something to reuse. Uses the REST endpoint rather than
 * `gh repo fork`, whose --fork-name would rename that existing fork.
 */
export async function forkGitHubRepo(sourcePath: string, targetPath: string): Promise<string | undefined> {
  const [owner, name] = targetPath.split("/");
  let fork: string;
  try {
    const login = await gh(["api", "user", "--jq", ".login"]);
    const args = ["api", `repos/${sourcePath}/forks`, "--method", "POST", "-f", `name=${name}`];
    // The endpoint forks into the user's own account unless an organization is named.
    if (login.toLowerCase() !== owner.toLowerCase()) args.push("-f", `organization=${owner}`);
    fork = await gh([...args, "--jq", '.full_name + " " + .created_at']);
  } catch (error) {
    return errorMessage(error);
  }
  const [fullName, createdAt] = fork.split(" ");
  if (Date.now() - Date.parse(createdAt) > FRESH_FORK_MS) {
    throw new Error(`You already have a fork of ${sourcePath}: ${fullName}.`);
  }
  if (fullName.toLowerCase() !== targetPath.toLowerCase()) {
    throw new Error(`GitHub created the fork of ${sourcePath} as ${fullName}, not ${targetPath}.`);
  }
  return undefined;
}

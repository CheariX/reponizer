import fs from "node:fs/promises";
import path from "node:path";
import { getHostRules, type Config } from "./config";
import { git, GitError, run } from "./git";
import { prepareDestination, pruneEmptyParents, publishBranch } from "./ops";
import { createRepoUrl, parseRemoteUrl } from "./remotes";
import { planTarget, type PlannedTarget, type TargetInput } from "./targets";
import type { Visibility } from "./types";

const NETWORK_TIMEOUT = 120_000;
// Signed commits can wait on the user approving the signature (e.g. 1Password's SSH agent).
const COMMIT_TIMEOUT = 120_000;
// `gh help exit-codes`: 4 means the command requires authentication.
const GH_EXIT_AUTH_REQUIRED = 4;

/**
 * How the repository comes into existence on the host. GitHub has no push-to-create, so the
 * GitHub CLI creates it there; GitLab and Gitea create the project when the first push arrives.
 */
export type CreationMethod = "github-cli" | "push";

export function creationMethodFor(host: string): CreationMethod {
  const lower = host.trim().toLowerCase();
  const real = getHostRules().aliasToReal.get(lower) ?? lower;
  return real === "github.com" ? "github-cli" : "push";
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface CreateInput extends TargetInput {
  visibility: Visibility;
}

export interface CreatePlan extends PlannedTarget {
  /** Repository path on the host, e.g. "owner/name" or "group/sub/name". */
  repoPath: string;
  method: CreationMethod;
  /** Only the GitHub CLI can choose; push-to-create hosts always start projects private. */
  visibility: Visibility;
}

/** Resolve form input into a creation plan, or undefined when the target is incomplete or unusable. */
export function planCreate(config: Config, input: CreateInput): CreatePlan | undefined {
  const target = planTarget(config, input);
  const repoPath = target && parseRemoteUrl(target.url)?.path;
  if (!target || !repoPath) return undefined;
  const method = creationMethodFor(input.host);
  // A GitHub owner is a single user or organization — there are no subgroups.
  if (method === "github-cli" && repoPath.split("/").length !== 2) return undefined;
  return { ...target, repoPath, method, visibility: method === "github-cli" ? input.visibility : "private" };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export type CreateOutcome =
  /** The host has the repository with the initial commit, and the local branch tracks it. */
  | { state: "published" }
  /** The GitHub CLI is missing or logged out: the local copy is ready, the host still lacks the repository. */
  | { state: "needs-remote"; reason: string; createUrl?: string }
  /** The host has the repository, but the initial push failed — "Publish Branch" retries it. */
  | { state: "push-failed"; error: unknown };

/**
 * Create the repository on the host plus an empty local copy whose origin points at it.
 * The local side goes first: until the host has the repository, the new folder holds nothing but
 * an empty commit, so every failure up to then removes it again and the form can be resubmitted.
 * Once the repository exists on the host, nothing is rolled back.
 */
export async function executeCreate(
  root: string,
  plan: CreatePlan,
  onStep?: (step: string) => void,
): Promise<CreateOutcome> {
  const folderIsNew = await prepareDestination(plan.destination, plan.relativePath);
  const discardLocal = () => discardLocalRepo(root, plan.destination, folderIsNew);

  onStep?.("Initializing the local repository…");
  await undoOnFailure(() => initLocalRepo(plan), discardLocal);

  if (plan.method === "github-cli") {
    onStep?.("Creating the repository on GitHub…");
    const unavailable = await undoOnFailure(() => createWithGitHubCli(plan), discardLocal);
    if (unavailable) {
      return { state: "needs-remote", reason: unavailable, createUrl: createRepoUrl(plan.url, plan.visibility) };
    }
    onStep?.("Pushing the initial commit…");
    try {
      await publishBranch(plan.destination);
    } catch (error) {
      return { state: "push-failed", error };
    }
    return { state: "published" };
  }

  onStep?.("Pushing the initial commit…");
  await undoOnFailure(() => pushToCreate(plan), discardLocal);
  return { state: "published" };
}

async function undoOnFailure<T>(work: () => Promise<T>, undo: () => Promise<void>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    await undo();
    throw error;
  }
}

async function initLocalRepo(plan: CreatePlan): Promise<void> {
  await fs.mkdir(plan.destination, { recursive: true });
  await git(plan.destination, ["init"]);
  await git(plan.destination, ["remote", "add", "origin", plan.url]);
  // A push needs a commit to carry; an empty one keeps the folder empty.
  await git(plan.destination, ["commit", "--allow-empty", "--message", "Initial commit"], {
    timeoutMs: COMMIT_TIMEOUT,
  });
}

/** Undo initLocalRepo: the whole folder when it was created for this, otherwise only its .git. */
async function discardLocalRepo(root: string, destination: string, folderIsNew: boolean): Promise<void> {
  // Best effort: the failure that triggered the rollback is the error worth reporting.
  if (folderIsNew) {
    await fs.rm(destination, { recursive: true, force: true }).catch(() => undefined);
    await pruneEmptyParents(root, destination);
  } else {
    await fs.rm(path.join(destination, ".git"), { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Create the repository with `gh repo create`, reusing the user's gh login. A missing or logged-out
 * gh is the documented fallback case, so it returns the reason instead of throwing; any other
 * failure (e.g. the name is taken) throws.
 */
async function createWithGitHubCli(plan: CreatePlan): Promise<string | undefined> {
  try {
    await run("gh", ["repo", "create", plan.repoPath, `--${plan.visibility}`], { timeoutMs: NETWORK_TIMEOUT });
    return undefined;
  } catch (error) {
    const err = error as { code?: string | number; stderr?: string; killed?: boolean; message: string };
    if (err.code === "ENOENT") return "The GitHub CLI (gh) is not installed.";
    if (err.code === GH_EXIT_AUTH_REQUIRED) return "The GitHub CLI is not logged in — run “gh auth login”.";
    // gh reports in a line or two (e.g. "HTTP 401: Bad credentials …" plus a hint), all of it relevant.
    const stderr = (err.stderr ?? "")
      .trim()
      .split(/\s*\n\s*/)
      .join(" ");
    throw new Error(`gh repo create: ${err.killed ? "timed out" : stderr || err.message}`);
  }
}

/** Push-to-create: the host creates the project from the first push it receives. */
async function pushToCreate(plan: CreatePlan): Promise<void> {
  try {
    await publishBranch(plan.destination);
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    if (/\[rejected\]/.test(error.stderr)) {
      throw new GitError(
        `${plan.relativePath} already exists on the host with other history`,
        error.args,
        error.stderr,
      );
    }
    // Hosts explain refusals (no permission, push-to-create disabled) in "remote:" lines, which
    // git follows with a generic "Could not read from remote repository".
    const explanation = remoteMessage(error.stderr);
    throw explanation ? new GitError(`git push: ${explanation}`, error.args, error.stderr) : error;
  }
}

function remoteMessage(stderr: string): string | undefined {
  const lines = stderr
    .split("\n")
    .filter((line) => line.startsWith("remote:"))
    .map((line) => line.slice("remote:".length).trim())
    .filter((line) => line && !/^[=*-]+$/.test(line));
  return lines.length > 0 ? lines.join(" ") : undefined;
}

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
 * How Reponizer first tries to create the repository on the host. The default is push-to-create
 * (GitLab and Gitea create the project when the first push arrives). GitHub has no push-to-create,
 * so it tries the GitHub CLI first and only then the push. Whatever fails last, the user creates the
 * repository by hand.
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
  /** Real host the repository lives on, e.g. "github.com" (never a folder alias). */
  remoteHost: string;
  /** Repository path on the host, e.g. "owner/name" or "group/sub/name". */
  repoPath: string;
  method: CreationMethod;
  /** Only GitHub lets Reponizer choose (CLI or prefilled page); push-to-create starts projects private. */
  visibility: Visibility;
}

/** Resolve form input into a creation plan, or undefined when the target is incomplete or unusable. */
export function planCreate(config: Config, input: CreateInput): CreatePlan | undefined {
  const target = planTarget(config, input);
  const parsed = target && parseRemoteUrl(target.url);
  if (!target || !parsed) return undefined;
  const method = creationMethodFor(input.host);
  // A GitHub owner is a single user or organization — there are no subgroups.
  if (method === "github-cli" && parsed.path.split("/").length !== 2) return undefined;
  return {
    ...target,
    remoteHost: parsed.host.toLowerCase(),
    repoPath: parsed.path,
    method,
    visibility: method === "github-cli" ? input.visibility : "private",
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export type CreateOutcome =
  /** The host has the repository with the initial commit, and the local branch tracks it. */
  | { state: "published" }
  /**
   * Nothing created the repository on the host: the local copy is ready, the user creates the
   * repository by hand (`createUrl`) and "Publish Branch" finishes the job.
   */
  | { state: "needs-remote"; pushError: unknown; cliProblem?: string; createUrl?: string }
  /** The GitHub CLI created the repository, but the initial push failed — "Publish Branch" retries it. */
  | { state: "push-failed"; error: unknown };

/**
 * Create the repository on the host plus an empty local copy whose origin points at it.
 * The local side goes first and is removed again when it fails. From then on the local copy stays:
 * a host that refuses the push leaves it waiting for the repository to be created by hand. The one
 * exception is a push rejected over existing history — the name is taken, so the folder is removed
 * and the form can be resubmitted with another name.
 */
export async function executeCreate(
  root: string,
  plan: CreatePlan,
  onStep?: (step: string) => void,
): Promise<CreateOutcome> {
  const folderIsNew = await prepareDestination(plan.destination, plan.relativePath);
  const discardLocal = () => discardLocalRepo(root, plan.destination, folderIsNew);

  onStep?.("Initializing the local repository…");
  try {
    await initLocalRepo(plan);
  } catch (error) {
    await discardLocal();
    throw error;
  }

  let cliProblem: string | undefined;
  if (plan.method === "github-cli") {
    onStep?.("Creating the repository on GitHub…");
    cliProblem = await createWithGitHubCli(plan);
    if (!cliProblem) {
      onStep?.("Pushing the initial commit…");
      try {
        await publishBranch(plan.destination);
      } catch (error) {
        return { state: "push-failed", error };
      }
      return { state: "published" };
    }
  }

  onStep?.("Pushing the initial commit…");
  try {
    await publishBranch(plan.destination);
    return { state: "published" };
  } catch (error) {
    if (error instanceof GitError && /\[rejected\]/.test(error.stderr)) {
      await discardLocal();
      throw new GitError(
        `${plan.relativePath} already exists on the host with other history`,
        error.args,
        error.stderr,
      );
    }
    return {
      state: "needs-remote",
      pushError: explainPushFailure(error),
      cliProblem,
      createUrl: createRepoUrl(plan.url, plan.visibility),
    };
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
 * Create the repository with `gh repo create`, reusing the user's gh login. Returns undefined on
 * success, otherwise why gh did not create it — never throws, since every gh failure (not installed,
 * logged out, name taken, …) falls through to the push.
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
    return `gh repo create: ${err.killed ? "timed out" : stderr || err.message}`;
  }
}

/**
 * Hosts explain a refused push-to-create (no permission, feature disabled) in "remote:" lines, which
 * git follows with a generic "Could not read from remote repository" — surface the explanation instead.
 */
function explainPushFailure(error: unknown): unknown {
  if (!(error instanceof GitError)) return error;
  const explanation = remoteMessage(error.stderr);
  return explanation ? new GitError(`git push: ${explanation}`, error.args, error.stderr) : error;
}

function remoteMessage(stderr: string): string | undefined {
  const lines = stderr
    .split("\n")
    .filter((line) => line.startsWith("remote:"))
    .map((line) => line.slice("remote:".length).trim())
    .filter((line) => line && !/^[=*-]+$/.test(line));
  return lines.length > 0 ? lines.join(" ") : undefined;
}

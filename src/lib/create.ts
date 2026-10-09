import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config";
import { git } from "./git";
import {
  createGitHubRepo,
  creationMethodFor,
  existingRepoError,
  isGitHubHost,
  provisionRemote,
  remoteState,
  type CreationMethod,
  type RemoteOutcome,
} from "./hosting";
import { prepareDestination, pruneEmptyParents, publishBranch } from "./ops";
import { parseRemoteUrl } from "./remotes";
import { planTarget, type PlannedTarget, type TargetInput } from "./targets";
import type { Visibility } from "./types";

// Signed commits can wait on the user approving the signature (e.g. 1Password's SSH agent).
const COMMIT_TIMEOUT = 120_000;

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface CreateInput extends TargetInput {
  visibility: Visibility;
  /** The forms' opt-in to the GitHub CLI; only counts on GitHub. */
  useGitHubCli: boolean;
}

export interface CreatePlan extends PlannedTarget {
  /** Real host the repository lives on, e.g. "github.com" (never a folder alias). */
  remoteHost: string;
  /** Repository path on the host, e.g. "owner/name" or "group/sub/name". */
  repoPath: string;
  method: CreationMethod;
  /** Only the GitHub CLI takes it; on the website the user picks it there. */
  visibility: Visibility;
}

/** Resolve form input into a creation plan, or undefined when the target is incomplete or unusable. */
export function planCreate(config: Config, input: CreateInput): CreatePlan | undefined {
  const target = planTarget(config, input);
  const parsed = target && parseRemoteUrl(target.url);
  if (!target || !parsed) return undefined;
  const method = creationMethodFor(input.host, input.useGitHubCli);
  // A GitHub owner is a single user or organization — there are no subgroups.
  if (isGitHubHost(input.host) && parsed.path.split("/").length !== 2) return undefined;
  return {
    ...target,
    remoteHost: parsed.host.toLowerCase(),
    repoPath: parsed.path,
    method,
    visibility: input.visibility,
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Create an empty local copy whose origin points at the new repository, then bring it to the host
 * (see hosting.provisionRemote). A repository with commits at that URL stops everything first. The
 * local side is removed again when setting it up fails; from then on it stays, and "Publish Branch"
 * is the way to push it later.
 */
export async function executeCreate(
  root: string,
  plan: CreatePlan,
  onStep?: (step: string) => void,
): Promise<RemoteOutcome> {
  const folderIsNew = await prepareDestination(plan.destination, plan.relativePath);

  onStep?.(`Checking ${plan.remoteHost}…`);
  const state = await remoteState(plan.url);
  if (state === "has-history") throw existingRepoError(plan.remoteHost, plan.repoPath);

  onStep?.("Initializing the local repository…");
  try {
    await initLocalRepo(plan);
  } catch (error) {
    await discardLocalRepo(root, plan.destination, folderIsNew);
    throw error;
  }

  // An empty repository that already exists (created by hand earlier, say) only needs the push.
  return provisionRemote(
    state === "empty" ? "push" : plan.method,
    {
      createOnGitHub: () => createGitHubRepo(plan.repoPath, plan.visibility),
      push: () => publishBranch(plan.destination),
    },
    onStep,
  );
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

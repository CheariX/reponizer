import { Clipboard, LaunchType, Toast, environment, showToast, updateCommandMetadata } from "@raycast/api";
import { readCachedIndex, rebuildIndex, refreshRepoEntries } from "./cache";
import { getConfig } from "./config";
import { failureReport, OpResult, runOnRepos, summarizeResults } from "./ops";
import type { Repo } from "./types";
import { errorMessage } from "./util";

type Summary = ReturnType<typeof summarizeResults>;

/** Runs `op` on every healthy repo of the cached index (scanning first without one), then refreshes their entries. */
async function runOnAllRepos(
  op: (repo: Repo) => Promise<OpResult>,
  onProgress: (message: string) => void,
): Promise<Summary> {
  const config = getConfig();
  let index = readCachedIndex(config.root);
  if (!index) {
    onProgress("Scanning repositories…");
    index = await rebuildIndex(config.root, config.maxDepth, config.defaultProtocol);
  }
  const repos = index.entries.filter((e): e is Repo => e.kind === "repo" && !e.error);
  const results = await runOnRepos(repos, op, config.networkConcurrency, (done, total) => {
    onProgress(`${done}/${total}`);
  });
  onProgress("Refreshing status…");
  await refreshRepoEntries(
    index,
    repos.map((r) => r.fullPath),
    config.defaultProtocol,
  );
  return summarizeResults(results);
}

/** Shared driver for the Fetch All / Pull All no-view commands. */
export async function runBulkCommand(
  verb: string,
  op: (repo: Repo) => Promise<OpResult>,
): Promise<Summary | undefined> {
  const toast = await showToast({ style: Toast.Style.Animated, title: `${verb} all repositories…` });
  try {
    const summary = await runOnAllRepos(op, (message) => {
      toast.message = message;
    });
    const { ok, skipped, failed } = summary;
    if (failed.length > 0) {
      toast.style = Toast.Style.Failure;
      toast.title = `${verb} finished with failures`;
      toast.message = `${ok} ok · ${skipped} skipped · ${failed.length} failed`;
      toast.primaryAction = {
        title: "Copy Failures",
        onAction: () => Clipboard.copy(failureReport(failed)),
      };
    } else {
      toast.style = Toast.Style.Success;
      toast.title = `${verb} finished`;
      toast.message = `${ok} ok · ${skipped} skipped`;
    }
    return summary;
  } catch (error) {
    toast.style = Toast.Style.Failure;
    toast.title = `${verb} failed`;
    toast.message = errorMessage(error);
    return undefined;
  }
}

/**
 * Driver for a bulk command that also runs on its manifest `interval`. A background run shows nothing
 * (no toast, HUD, or alert fires on a timer): it reports through the command's subtitle and throws on
 * failures, so the launcher marks the command with the error. A manual run behaves like
 * `runBulkCommand` and records its outcome in the subtitle too.
 */
export async function runScheduledBulkCommand(verb: string, op: (repo: Repo) => Promise<OpResult>): Promise<void> {
  if (environment.launchType !== LaunchType.Background) {
    const summary = await runBulkCommand(verb, op);
    await updateCommandMetadata({ subtitle: lastRunSubtitle(summary) });
    return;
  }
  let summary: Summary | undefined;
  try {
    summary = await runOnAllRepos(op, () => {});
  } finally {
    await updateCommandMetadata({ subtitle: lastRunSubtitle(summary) });
  }
  const { failed } = summary;
  if (failed.length > 0) {
    throw new Error(
      `${verb} failed for ${failed.length} ${failed.length === 1 ? "repository" : "repositories"}:\n${failureReport(failed)}`,
    );
  }
}

function lastRunSubtitle(summary: Summary | undefined): string {
  const when = new Date().toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" });
  if (!summary) return `Last run ${when} · failed`;
  const { ok, skipped, failed } = summary;
  return `Last run ${when} · ${ok} ok · ${skipped} skipped${failed.length > 0 ? ` · ${failed.length} failed` : ""}`;
}

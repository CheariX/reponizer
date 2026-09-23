import { Color, Icon, List } from "@raycast/api";
import { protocolOf } from "../lib/remotes";
import { totalChanges } from "../lib/status";
import type { ForkInfo, OffloadedRepo, RemoteCheckState, Repo, RepoEntry } from "../lib/types";
import { formatBytes, relativeTime } from "../lib/util";
import type { RepoIndexController } from "../hooks/useRepoIndex";
import { RepoActions } from "./RepoActions";

const CHECK_COLORS: Record<RemoteCheckState, Color> = {
  ok: Color.Green,
  mismatch: Color.Red,
  "no-origin": Color.Orange,
  "no-remotes": Color.Orange,
  unstructured: Color.Yellow,
  unknown: Color.SecondaryText,
};

function repoAccessories(repo: Repo): List.Item.Accessory[] {
  const accessories: List.Item.Accessory[] = [];
  if (repo.error) {
    accessories.push({ icon: { source: Icon.XMarkCircle, tintColor: Color.Red }, tooltip: repo.error });
  }
  if (!repo.error && repo.remoteCheck.state !== "ok") {
    accessories.push({
      icon: { source: Icon.Warning, tintColor: CHECK_COLORS[repo.remoteCheck.state] },
      tooltip: repo.remoteCheck.message,
    });
  }
  if (repo.duplicateOf?.length) {
    accessories.push({
      icon: { source: Icon.CopyClipboard, tintColor: Color.Purple },
      tooltip: `Same origin as ${repo.duplicateOf.join(", ")}`,
    });
  }
  if (repo.fork) {
    accessories.push({ tag: { value: "fork", color: Color.Magenta }, tooltip: `Fork of ${repo.fork.url}` });
  }
  if (repo.fork?.behind && repo.fork.behind > 0) {
    accessories.push({
      tag: { value: `↓${repo.fork.behind} upstream`, color: Color.Orange },
      tooltip: `${repo.fork.behind} commits behind ${repo.fork.ref}`,
    });
  }
  const status = repo.status;
  if (status) {
    if (status.conflicted > 0) {
      accessories.push({ tag: { value: "conflicts", color: Color.Red }, tooltip: "Merge conflicts" });
    }
    const changes = totalChanges(status);
    if (changes > 0) {
      accessories.push({
        icon: { source: Icon.Pencil, tintColor: Color.Yellow },
        text: { value: String(changes), color: Color.Yellow },
        tooltip: `${status.staged} staged · ${status.unstaged} unstaged · ${status.untracked} untracked`,
      });
    }
    if (status.ahead > 0 || status.behind > 0) {
      const parts = [status.ahead > 0 ? `↑${status.ahead}` : "", status.behind > 0 ? `↓${status.behind}` : ""];
      accessories.push({
        tag: { value: parts.filter(Boolean).join(" "), color: Color.Orange },
        tooltip: `${status.ahead} ahead, ${status.behind} behind ${status.upstream ?? "upstream"}`,
      });
    }
    accessories.push({
      icon: Icon.Code,
      text: status.detached ? { value: "detached", color: Color.Red } : status.branch,
      tooltip: status.upstream ? `Tracking ${status.upstream}` : "No upstream configured",
    });
  }
  accessories.push({ text: repo.sizeBytes !== undefined ? formatBytes(repo.sizeBytes) : "—", tooltip: "Size on disk" });
  return accessories;
}

function offloadedAccessories(entry: OffloadedRepo): List.Item.Accessory[] {
  const accessories: List.Item.Accessory[] = [];
  if (entry.error) {
    accessories.push({ icon: { source: Icon.XMarkCircle, tintColor: Color.Red }, tooltip: entry.error });
  }
  accessories.push({ tag: { value: "offloaded", color: Color.Blue }, tooltip: "Local copy removed to save space" });
  if (entry.lastKnownSizeBytes !== undefined) {
    accessories.push({ text: `was ${formatBytes(entry.lastKnownSizeBytes)}`, tooltip: "Size before offloading" });
  }
  return accessories;
}

function forkUpstreamText(fork: ForkInfo): string {
  if (!fork.ref) return "not fetched yet";
  if (fork.ahead === undefined || fork.behind === undefined) return fork.ref;
  return `${fork.ref} · ${fork.ahead} ahead · ${fork.behind} behind`;
}

function RepoDetail({ entry }: { entry: RepoEntry }) {
  const Meta = List.Item.Detail.Metadata;
  if (entry.kind === "offloaded") {
    return (
      <List.Item.Detail
        metadata={
          <Meta>
            <Meta.TagList title="State">
              <Meta.TagList.Item text="Offloaded" color={Color.Blue} />
            </Meta.TagList>
            <Meta.Label title="Path" text={entry.relativePath} />
            <Meta.Label title="Origin" text={entry.originUrl || "—"} />
            {entry.branch && <Meta.Label title="Branch" text={entry.branch} />}
            {entry.offloadedAt && <Meta.Label title="Offloaded" text={relativeTime(entry.offloadedAt)} />}
            {entry.lastKnownSizeBytes !== undefined && (
              <Meta.Label title="Size Before" text={formatBytes(entry.lastKnownSizeBytes)} />
            )}
            {entry.error && <Meta.Label title="Error" text={entry.error} />}
          </Meta>
        }
      />
    );
  }
  const status = entry.status;
  const check = entry.remoteCheck;
  return (
    <List.Item.Detail
      metadata={
        <Meta>
          <Meta.TagList title="Origin Check">
            <Meta.TagList.Item text={check.state} color={CHECK_COLORS[check.state]} />
          </Meta.TagList>
          <Meta.Label title="Path" text={entry.relativePath} />
          {status && (
            <>
              <Meta.Label title="Branch" text={status.detached ? "detached HEAD" : status.branch} />
              <Meta.Label title="Upstream" text={status.upstream ?? "—"} />
              <Meta.Label
                title="Sync"
                text={
                  status.ahead === 0 && status.behind === 0
                    ? "in sync"
                    : `${status.ahead} ahead · ${status.behind} behind`
                }
              />
              <Meta.Label
                title="Changes"
                text={`${status.staged} staged · ${status.unstaged} unstaged · ${status.untracked} untracked`}
              />
              {status.stashes > 0 && <Meta.Label title="Stashes" text={String(status.stashes)} />}
            </>
          )}
          <Meta.Label title="Size" text={entry.sizeBytes !== undefined ? formatBytes(entry.sizeBytes) : "—"} />
          {entry.lastCommitAt && <Meta.Label title="Last Commit" text={relativeTime(entry.lastCommitAt)} />}
          {entry.fork && (
            <>
              <Meta.Label title="Fork Of" text={entry.fork.relativePath ?? entry.fork.url} />
              <Meta.Label title="Upstream Sync" text={forkUpstreamText(entry.fork)} />
            </>
          )}
          <Meta.Separator />
          {entry.remotes.length === 0 && <Meta.Label title="Remotes" text="none" />}
          {entry.remotes.map((remote) => (
            <Meta.Label
              key={remote.name}
              title={`${remote.name} (${protocolOf(remote.fetchUrl) ?? "?"})`}
              text={remote.fetchUrl}
            />
          ))}
          {check.state !== "ok" && check.expectedUrl && (
            <>
              <Meta.Separator />
              <Meta.Label title="Expected Origin" text={check.expectedUrl} />
            </>
          )}
          {entry.duplicateOf?.length ? <Meta.Label title="Duplicates" text={entry.duplicateOf.join(", ")} /> : null}
          {entry.error && <Meta.Label title="Error" text={entry.error} />}
        </Meta>
      }
    />
  );
}

export function RepoListItem(props: {
  entry: RepoEntry;
  ctl: RepoIndexController;
  showDetail: boolean;
  setShowDetail: (value: boolean) => void;
}) {
  const { entry, ctl, showDetail, setShowDetail } = props;
  const icon =
    entry.kind === "offloaded"
      ? { source: Icon.Cloud, tintColor: Color.Blue }
      : entry.error
        ? { source: Icon.Folder, tintColor: Color.Red }
        : Icon.Folder;
  return (
    <List.Item
      id={entry.relativePath}
      icon={icon}
      title={entry.name}
      keywords={entry.relativePath.split("/")}
      accessories={
        showDetail ? undefined : entry.kind === "repo" ? repoAccessories(entry) : offloadedAccessories(entry)
      }
      detail={showDetail ? <RepoDetail entry={entry} /> : undefined}
      actions={<RepoActions entry={entry} ctl={ctl} showDetail={showDetail} setShowDetail={setShowDetail} />}
    />
  );
}

import {
  Action,
  ActionPanel,
  Alert,
  Clipboard,
  Form,
  Icon,
  Toast,
  confirmAlert,
  showToast,
  useNavigation,
} from "@raycast/api";
import { useMemo, useRef, useState } from "react";
import { useRepoTarget } from "../hooks/useRepoTarget";
import { showRemoteOutcome, type OutcomeWording } from "./remoteOutcome";
import { targetDropdownItems } from "./TargetDropdownItems";
import type { RepoIndexController } from "../hooks/useRepoIndex";
import { getConfig } from "../lib/config";
import { ForkPlan, PushScope, executeFork, gitHubForkSource, planFork } from "../lib/fork";
import { hostOf } from "../lib/filters";
import { creationMethodFor, isGitHubHost } from "../lib/hosting";
import { protocolOf } from "../lib/remotes";
import { placementProblem } from "../lib/targets";
import type { Protocol, Repo, Visibility } from "../lib/types";
import { describeTransition, errorDetails, errorMessage } from "../lib/util";

type ProtocolChoice = "as-default" | Protocol;

const PUSH_SCOPE_LABELS: Record<PushScope, string> = {
  all: "all branches and tags",
  current: "the current branch and tags",
  none: "nothing — remotes only",
};

/**
 * The action that pushes a fork later. "Push to Origin" only exists for forks, which need the upstream
 * remote; a repository without an origin has none, and "Publish Branch" is what it offers.
 */
function forkPushAction(plan: ForkPlan): string {
  return plan.upstreamUrl ? "Push to Origin" : "Publish Branch";
}

/** "Created By" row of the fork forms: how the fork will get onto its host. */
export function forkCreatedBy(plan: ForkPlan | undefined): string {
  if (!plan) return "—";
  const action = `“${forkPushAction(plan)}”`;
  if (plan.gitHubForkOf) {
    return `A GitHub fork of ${plan.gitHubForkOf} (GitHub CLI) with all its branches and tags — local commits go up with ${action}`;
  }
  switch (plan.method) {
    case "github-cli":
      return `The GitHub CLI (gh repo create), then the push — without it, you create it on GitHub and use ${action}`;
    case "push":
      return `The push (a push-to-create host) — if the host refuses, you create it there and use ${action}`;
    case "manual":
      return `You, on the host's website — then ${action} pushes the local copy`;
  }
}

/** Toast wording for a fork's RemoteOutcome, shared with the clone form's fork variant. */
export function forkWording(plan: ForkPlan): OutcomeWording {
  return {
    url: plan.targetUrl,
    remoteHost: plan.remoteHost,
    relativePath: plan.targetRelativePath,
    verb: "Forked",
    doneTitle: "Forked",
    createHint: plan.gitHubForkOf
      ? `Fork ${plan.gitHubForkOf} on GitHub as ${plan.repoPath}`
      : `Create an empty repository ${plan.repoPath} on ${plan.remoteHost}`,
    pushAction: forkPushAction(plan),
  };
}

/**
 * What the fork forms show for a target: the GitHub CLI opt-in on GitHub (a real fork when the source is
 * someone else's GitHub repository, else gh repo create), push scope and visibility where they apply.
 */
export function forkFormFields(
  host: string,
  namespace: string,
  upstreamUrl: string | undefined,
  useGitHubCli: boolean,
) {
  const onGitHub = isGitHubHost(host);
  const method = creationMethodFor(host, useGitHubCli);
  const canFork = !!gitHubForkSource(host, namespace, upstreamUrl, true);
  const realFork = canFork && useGitHubCli;
  return {
    showGitHubCli: onGitHub,
    gitHubCliLabel: canFork
      ? "Fork it on GitHub with the GitHub CLI (gh)"
      : "Create it on GitHub with the GitHub CLI (gh)",
    gitHubCliInfo: canFork
      ? "A real GitHub fork of the original, made with your gh login; GitHub copies its branches and tags. Off: you create the repository on GitHub yourself and push afterwards."
      : "Creates the repository with your gh login and pushes right away. Off: you create it on GitHub yourself and push afterwards.",
    showPushScope: method !== "manual" && !realFork,
    showVisibility: method === "github-cli" && !realFork,
    namespaceInfo: onGitHub
      ? "Your GitHub user or one of your organizations. Type to use one that does not exist locally yet."
      : "Owner, group, or subgroup below the host. Type to use one that does not exist locally yet.",
    incompleteError: onGitHub
      ? "Pick a host and a single user or organization, and enter a repository name."
      : "Pick a host and namespace, and enter a repository name.",
  };
}

export function ForkView({ repo, ctl }: { repo: Repo; ctl: RepoIndexController }) {
  const { pop } = useNavigation();
  const config = getConfig();
  const entries = useMemo(() => ctl.index?.entries ?? [], [ctl.index]);
  const target = useRepoTarget(entries, hostOf(repo));

  const [name, setName] = useState(repo.name);
  const [keepOriginal, setKeepOriginal] = useState(false);
  const [pushScope, setPushScope] = useState<PushScope>("all");
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [useGitHubCli, setUseGitHubCli] = useState(false);
  const [choice, setChoice] = useState<ProtocolChoice>("as-default");
  const [isWorking, setIsWorking] = useState(false);
  const [nameError, setNameError] = useState<string>();
  // A second submit while one runs would race it (see CreateRepoForm).
  const inFlight = useRef(false);

  // Keep the fork on the protocol the repo already uses unless asked otherwise.
  const originProtocol: Protocol = repo.origin && protocolOf(repo.origin.fetchUrl) === "https" ? "https" : "ssh";
  const protocol: Protocol = choice === "as-default" ? originProtocol : choice;

  const plan = useMemo(
    () =>
      planFork(config, {
        host: target.host,
        namespace: target.namespace,
        name,
        protocol,
        upstreamUrl: repo.origin?.fetchUrl,
        keepOriginal,
        pushScope,
        visibility,
        useGitHubCli,
      }),
    [
      config,
      target.host,
      target.namespace,
      name,
      protocol,
      repo.origin,
      keepOriginal,
      pushScope,
      visibility,
      useGitHubCli,
    ],
  );

  const fields = forkFormFields(target.host, target.namespace, repo.origin?.fetchUrl, useGitHubCli);
  const problem = plan && placementProblem(config, entries, plan.targetRelativePath);

  const fate = keepOriginal ? `Stays at ${repo.relativePath}` : `Moves from ${repo.relativePath}`;

  // The form lists the URLs as labelled rows; the alert only takes one short centred string (the
  // title already says copy vs. move), so it confirms the paths and leaves the details to the form.
  const summary = (plan: ForkPlan) => {
    const how = plan.gitHubForkOf
      ? `Forking ${plan.gitHubForkOf} on GitHub.`
      : plan.method === "manual"
        ? `You create it on ${plan.remoteHost} afterwards.`
        : `${plan.method === "github-cli" ? "Creating it on GitHub, pushing" : "Pushing"} ${PUSH_SCOPE_LABELS[plan.pushScope]}.`;
    return `${describeTransition(repo.relativePath, plan.targetRelativePath)}\n\n${how}`;
  };

  const submit = async () => {
    if (inFlight.current) return;
    if (!plan) {
      setNameError(fields.incompleteError);
      return;
    }
    if (problem) {
      setNameError(problem);
      return;
    }
    const confirmed = await confirmAlert({
      title: keepOriginal ? "Fork into a New Local Copy" : "Fork and Move Folder",
      message: summary(plan),
      primaryAction: { title: "Fork", style: keepOriginal ? Alert.ActionStyle.Default : Alert.ActionStyle.Destructive },
    });
    if (!confirmed) return;

    inFlight.current = true;
    setIsWorking(true);
    const toast = await showToast({ style: Toast.Style.Animated, title: `Forking to ${plan.targetRelativePath}…` });
    try {
      const { fullPath, outcome } = await executeFork(config, repo, plan, (step) => {
        toast.message = step;
      });
      await ctl.reconcile(repo.fullPath);
      if (fullPath !== repo.fullPath) await ctl.reconcile(fullPath);
      showRemoteOutcome(toast, outcome, forkWording(plan));
      pop();
    } catch (error) {
      // The local fork is incomplete: the folder may have moved, or a copy may be left at the target,
      // so both places are refreshed.
      await ctl.reconcile(repo.fullPath);
      await ctl.reconcile(plan.targetDestination);
      toast.style = Toast.Style.Failure;
      toast.title = "Fork failed";
      toast.message = errorMessage(error);
      toast.primaryAction = { title: "Copy Error", onAction: () => Clipboard.copy(errorDetails(error)) };
    } finally {
      inFlight.current = false;
      setIsWorking(false);
    }
  };

  return (
    <Form
      isLoading={isWorking}
      navigationTitle={`Fork ${repo.name}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Fork Repository" icon={Icon.NewDocument} onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.Dropdown
        id="host"
        title="Host"
        value={target.host}
        filtering={false}
        onSearchTextChange={target.setHostQuery}
        onChange={target.setHost}
        placeholder="Search or type a host"
        info="Type to use a host that has no repositories under the root yet."
      >
        {targetDropdownItems(target.hostOptions, Icon.Globe, "Select a Host")}
      </Form.Dropdown>
      <Form.Dropdown
        id="namespace"
        title="Namespace"
        value={target.namespace}
        filtering={false}
        onSearchTextChange={target.setNamespaceQuery}
        onChange={target.setNamespace}
        placeholder="Search or type a namespace"
        info={fields.namespaceInfo}
      >
        {targetDropdownItems(target.namespaceOptions, Icon.Person, "Select a Namespace")}
      </Form.Dropdown>
      <Form.TextField
        id="name"
        title="Repository Name"
        placeholder={repo.name}
        value={name}
        error={nameError}
        onChange={(value) => {
          setName(value);
          setNameError(undefined);
        }}
      />
      {fields.showGitHubCli && (
        <Form.Checkbox
          id="useGitHubCli"
          title="GitHub CLI"
          label={fields.gitHubCliLabel}
          value={useGitHubCli}
          onChange={setUseGitHubCli}
          info={fields.gitHubCliInfo}
        />
      )}
      <Form.Checkbox
        id="keepOriginal"
        title="Original"
        label="Keep the original local copy"
        value={keepOriginal}
        onChange={setKeepOriginal}
        info="Off: this local copy becomes the fork and its folder moves. On: the fork is created as a second local copy."
      />
      {fields.showPushScope && (
        <Form.Dropdown
          id="pushScope"
          title="Push"
          value={pushScope}
          onChange={(value) => setPushScope(value as PushScope)}
        >
          <Form.Dropdown.Item value="all" title="All Branches and Tags" />
          <Form.Dropdown.Item value="current" title="Current Branch and Tags" />
          <Form.Dropdown.Item value="none" title="Nothing — Set Up Remotes Only" />
        </Form.Dropdown>
      )}
      {fields.showVisibility && (
        <Form.Dropdown
          id="visibility"
          title="Visibility"
          value={visibility}
          onChange={(value) => setVisibility(value as Visibility)}
        >
          <Form.Dropdown.Item value="private" title="Private" icon={Icon.Lock} />
          <Form.Dropdown.Item value="public" title="Public" icon={Icon.Globe} />
        </Form.Dropdown>
      )}
      <Form.Dropdown
        id="protocol"
        title="Protocol"
        value={choice}
        onChange={(value) => setChoice(value as ProtocolChoice)}
      >
        <Form.Dropdown.Item value="as-default" title={`Same as Origin (${originProtocol.toUpperCase()})`} />
        <Form.Dropdown.Item value="ssh" title="SSH" />
        <Form.Dropdown.Item value="https" title="HTTPS" />
      </Form.Dropdown>
      <Form.Separator />
      <Form.Description title="New Location" text={plan?.targetRelativePath ?? "—"} />
      <Form.Description title="New Origin" text={plan?.targetUrl ?? "—"} />
      <Form.Description
        title={config.upstreamRemoteName}
        text={repo.origin?.fetchUrl ?? "no origin to keep as upstream"}
      />
      <Form.Description title="Local Copy" text={fate} />
      <Form.Description title="Created By" text={forkCreatedBy(plan)} />
      {problem && <Form.Description title="⚠︎" text={problem} />}
    </Form>
  );
}

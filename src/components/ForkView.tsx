import {
  Action,
  ActionPanel,
  Alert,
  Clipboard,
  Form,
  Icon,
  Toast,
  confirmAlert,
  open,
  showToast,
  useNavigation,
} from "@raycast/api";
import { useMemo, useState } from "react";
import { useForkTarget } from "../hooks/useForkTarget";
import type { RepoIndexController } from "../hooks/useRepoIndex";
import { getConfig } from "../lib/config";
import { ForkPushError, PushScope, createRepoUrl, executeFork, planFork } from "../lib/fork";
import { hostOf } from "../lib/filters";
import { protocolOf } from "../lib/remotes";
import type { Protocol, Repo } from "../lib/types";
import { describeTransition, errorMessage } from "../lib/util";

type ProtocolChoice = "as-default" | Protocol;

const PUSH_SCOPE_LABELS: Record<PushScope, string> = {
  all: "all branches and tags",
  current: "the current branch and tags",
  none: "nothing — remotes only",
};

export function ForkView({ repo, ctl }: { repo: Repo; ctl: RepoIndexController }) {
  const { pop } = useNavigation();
  const config = getConfig();
  const entries = useMemo(() => ctl.index?.entries ?? [], [ctl.index]);
  const target = useForkTarget(entries, hostOf(repo));

  const [name, setName] = useState(repo.name);
  const [keepOriginal, setKeepOriginal] = useState(false);
  const [pushScope, setPushScope] = useState<PushScope>("all");
  const [choice, setChoice] = useState<ProtocolChoice>("as-default");
  const [isWorking, setIsWorking] = useState(false);
  const [nameError, setNameError] = useState<string>();

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
      }),
    [config, target.host, target.namespace, name, protocol, repo.origin, keepOriginal, pushScope],
  );

  const taken = plan ? entries.some((entry) => entry.relativePath === plan.targetRelativePath) : false;

  const fate = keepOriginal ? `Stays at ${repo.relativePath}` : `Moves from ${repo.relativePath}`;

  // The form lists the URLs as labelled rows; the alert only takes one centred string, so it
  // confirms the move itself and leaves the details to the form.
  const summary = () => {
    if (!plan) return "—";
    const lead = keepOriginal ? "Fork into a second local copy." : "Move this local copy to the fork.";
    const tail = [
      keepOriginal ? `${repo.relativePath} stays where it is.` : "",
      `Pushing ${PUSH_SCOPE_LABELS[pushScope]}.`,
    ].filter(Boolean);
    return `${describeTransition(repo.relativePath, plan.targetRelativePath, lead)}\n\n${tail.join("\n")}`;
  };

  const submit = async () => {
    if (!plan) {
      setNameError("Pick a host and namespace, and enter a repository name.");
      return;
    }
    if (taken) {
      setNameError(`${plan.targetRelativePath} already exists.`);
      return;
    }
    const confirmed = await confirmAlert({
      title: keepOriginal ? "Fork into a New Local Copy" : "Fork and Move Folder",
      message: summary(),
      primaryAction: { title: "Fork", style: keepOriginal ? Alert.ActionStyle.Default : Alert.ActionStyle.Destructive },
    });
    if (!confirmed) return;

    setIsWorking(true);
    const toast = await showToast({ style: Toast.Style.Animated, title: `Forking to ${plan.targetRelativePath}…` });
    try {
      const forkPath = await executeFork(config, repo, plan);
      await ctl.reconcile(repo.fullPath);
      if (forkPath !== repo.fullPath) await ctl.reconcile(forkPath);
      toast.style = Toast.Style.Success;
      toast.title = "Forked";
      toast.message = plan.targetRelativePath;
      pop();
    } catch (error) {
      // The remotes stay rewired on a push failure: creating the repo and retrying is the fix,
      // and rolling back would throw that setup away.
      await ctl.reconcile(repo.fullPath);
      toast.style = Toast.Style.Failure;
      toast.message = errorMessage(error);
      if (error instanceof ForkPushError) {
        const createUrl = createRepoUrl(error.targetUrl);
        toast.title = "Fork pushed nowhere — does the target repository exist?";
        toast.primaryAction = createUrl
          ? { title: "Create the Repository", onAction: () => open(createUrl) }
          : { title: "Copy Error", onAction: () => Clipboard.copy(errorMessage(error)) };
      } else {
        toast.title = "Fork failed";
        toast.primaryAction = { title: "Copy Error", onAction: () => Clipboard.copy(errorMessage(error)) };
      }
    } finally {
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
      <Form.Dropdown id="host" title="Host" value={target.host} onChange={target.setHost}>
        {target.hosts.map((host) => (
          <Form.Dropdown.Item key={host} value={host} title={host} icon={Icon.Globe} />
        ))}
      </Form.Dropdown>
      <Form.Dropdown
        id="namespace"
        title="Namespace"
        value={target.namespace}
        filtering
        onSearchTextChange={target.setNamespaceQuery}
        onChange={target.setNamespace}
        info="Owner, group, or subgroup below the host. Type to use one that does not exist locally yet."
      >
        {target.namespaceOptions.map((namespace) => (
          <Form.Dropdown.Item key={namespace} value={namespace} title={namespace} icon={Icon.Person} />
        ))}
      </Form.Dropdown>
      <Form.TextField
        id="name"
        title="Repository Name"
        value={name}
        error={nameError}
        onChange={(value) => {
          setName(value);
          setNameError(undefined);
        }}
      />
      <Form.Checkbox
        id="keepOriginal"
        title="Original"
        label="Keep the original local copy"
        value={keepOriginal}
        onChange={setKeepOriginal}
        info="Off: this local copy becomes the fork and its folder moves. On: the fork is created as a second local copy."
      />
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
      {taken && <Form.Description title="⚠︎" text="A repository already exists at that location." />}
    </Form>
  );
}

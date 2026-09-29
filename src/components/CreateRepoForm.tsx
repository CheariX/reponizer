import { Action, ActionPanel, Clipboard, Form, Icon, Toast, open, showToast } from "@raycast/api";
import { useMemo, useRef, useState } from "react";
import { useRepoTarget } from "../hooks/useRepoTarget";
import { getConfig } from "../lib/config";
import { creationMethodFor, executeCreate, planCreate, type CreateOutcome, type CreatePlan } from "../lib/create";
import { primaryHost } from "../lib/targets";
import type { RepoEntry, Visibility } from "../lib/types";
import { errorDetails, errorMessage } from "../lib/util";

interface CreateRepoFormProps {
  entries: RepoEntry[];
  /** Host of the repository the form was opened from; defaults to the host with the most repositories. */
  sourceHost?: string;
  initialName?: string;
  /** Only for the pushed variant — Raycast owns a root command's title. */
  navigationTitle?: string;
  /** Runs once the local copy exists, partial successes included: refresh the index and navigate away. */
  onCreated: (fullPath: string) => Promise<void>;
}

export function CreateRepoForm({ entries, sourceHost, initialName, navigationTitle, onCreated }: CreateRepoFormProps) {
  const config = useRef(getConfig()).current;
  const target = useRepoTarget(entries, sourceHost ?? primaryHost(entries));

  const [name, setName] = useState(initialName?.trim() ?? "");
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [isWorking, setIsWorking] = useState(false);
  const [nameError, setNameError] = useState<string>();

  const viaGitHub = creationMethodFor(target.host) === "github-cli";

  const plan = useMemo(
    () =>
      planCreate(config, {
        host: target.host,
        namespace: target.namespace,
        name,
        protocol: config.defaultProtocol,
        visibility,
      }),
    [config, target.host, target.namespace, name, visibility],
  );

  const taken = plan ? entries.some((entry) => entry.relativePath === plan.relativePath) : false;

  const submit = async () => {
    if (!plan) {
      setNameError(
        viaGitHub
          ? "Pick a host and a single user or organization, and enter a repository name."
          : "Pick a host and namespace, and enter a repository name.",
      );
      return;
    }
    if (taken) {
      setNameError(`${plan.relativePath} already exists.`);
      return;
    }

    setIsWorking(true);
    const toast = await showToast({ style: Toast.Style.Animated, title: `Creating ${plan.relativePath}…` });
    let outcome: CreateOutcome;
    try {
      outcome = await executeCreate(config.root, plan, (step) => {
        toast.message = step;
      });
    } catch (error) {
      // Nothing is left behind locally, so the form stays open for another attempt.
      setIsWorking(false);
      toast.style = Toast.Style.Failure;
      toast.title = "Could not create the repository";
      toast.message = errorMessage(error);
      toast.primaryAction = { title: "Copy Error", onAction: () => Clipboard.copy(errorDetails(error)) };
      return;
    }
    showOutcome(toast, plan, outcome);
    await onCreated(plan.destination);
  };

  return (
    <Form
      isLoading={isWorking}
      navigationTitle={navigationTitle}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Create Repository" icon={Icon.Plus} onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.Dropdown
        id="host"
        title="Host"
        value={target.host}
        filtering
        onSearchTextChange={target.setHostQuery}
        onChange={target.setHost}
        info="Type to use a host that has no repositories under the root yet."
      >
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
        info={
          viaGitHub
            ? "Your GitHub user or one of your organizations. Type to use one that does not exist locally yet."
            : "Owner, group, or subgroup below the host. Type to use one that does not exist locally yet."
        }
      >
        {target.namespaceOptions.map((namespace) => (
          <Form.Dropdown.Item key={namespace} value={namespace} title={namespace} icon={Icon.Person} />
        ))}
      </Form.Dropdown>
      <Form.TextField
        id="name"
        title="Repository Name"
        placeholder="my-project"
        value={name}
        error={nameError}
        onChange={(value) => {
          setName(value);
          setNameError(undefined);
        }}
        autoFocus
      />
      {viaGitHub && (
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
      <Form.Separator />
      <Form.Description title="Location" text={plan?.relativePath ?? "—"} />
      <Form.Description title="Origin" text={plan?.url ?? "—"} />
      <Form.Description
        title="Created By"
        text={
          viaGitHub
            ? "The GitHub CLI (gh repo create), then the empty initial commit is pushed"
            : "Pushing the empty initial commit — GitLab and Gitea create a private project on push"
        }
      />
      {taken && <Form.Description title="⚠︎" text="A repository already exists at that location." />}
    </Form>
  );
}

function showOutcome(toast: Toast, plan: CreatePlan, outcome: CreateOutcome): void {
  switch (outcome.state) {
    case "published":
      toast.style = Toast.Style.Success;
      toast.title = "Repository created";
      toast.message = plan.relativePath;
      return;
    case "needs-remote": {
      const { createUrl } = outcome;
      toast.style = Toast.Style.Failure;
      toast.title = "Created locally, but not on GitHub";
      toast.message = `${outcome.reason} Create it on GitHub, then use “Publish Branch”.`;
      if (createUrl) toast.primaryAction = { title: "Create on GitHub", onAction: () => open(createUrl) };
      return;
    }
    case "push-failed": {
      const { error } = outcome;
      toast.style = Toast.Style.Failure;
      toast.title = "Created on GitHub, but the push failed";
      toast.message = `${errorMessage(error)} — retry with “Publish Branch”.`;
      toast.primaryAction = { title: "Copy Error", onAction: () => Clipboard.copy(errorDetails(error)) };
      return;
    }
  }
}

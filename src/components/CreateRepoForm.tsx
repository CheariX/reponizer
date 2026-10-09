import { Action, ActionPanel, Clipboard, Form, Icon, Toast, showToast } from "@raycast/api";
import { useMemo, useRef, useState } from "react";
import { useRepoTarget } from "../hooks/useRepoTarget";
import { showRemoteOutcome } from "./remoteOutcome";
import { targetDropdownItems } from "./TargetDropdownItems";
import { getConfig } from "../lib/config";
import { executeCreate, planCreate } from "../lib/create";
import { creationMethodFor, isGitHubHost, type CreationMethod, type RemoteOutcome } from "../lib/hosting";
import { placementProblem, primaryHost } from "../lib/targets";
import type { RepoEntry, Visibility } from "../lib/types";
import { errorDetails, errorMessage } from "../lib/util";

const CREATED_BY: Record<CreationMethod, string> = {
  "github-cli":
    "The GitHub CLI (gh repo create), then the push — if gh fails, you create it on GitHub and use “Publish Branch”",
  push: "Pushing the initial commit (a push-to-create host) — if the host refuses, you create it there and use “Publish Branch”",
  manual: "You, on the host's website — then “Publish Branch” pushes the local copy",
};

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
  const [useGitHubCli, setUseGitHubCli] = useState(false);
  const [isWorking, setIsWorking] = useState(false);
  const [nameError, setNameError] = useState<string>();
  // isLoading does not disable the submit action, and state lags a render behind: a quick second
  // submit would race the first, and its rollback could remove the folder the first one is using.
  const inFlight = useRef(false);

  const onGitHub = isGitHubHost(target.host);
  const method = creationMethodFor(target.host, useGitHubCli);

  const plan = useMemo(
    () =>
      planCreate(config, {
        host: target.host,
        namespace: target.namespace,
        name,
        protocol: config.defaultProtocol,
        visibility,
        useGitHubCli,
      }),
    [config, target.host, target.namespace, name, visibility, useGitHubCli],
  );

  const problem = plan && placementProblem(config, entries, plan.relativePath);

  const submit = async () => {
    if (inFlight.current) return;
    if (!plan) {
      setNameError(
        onGitHub
          ? "Pick a host and a single user or organization, and enter a repository name."
          : "Pick a host and namespace, and enter a repository name.",
      );
      return;
    }
    if (problem) {
      setNameError(problem);
      return;
    }

    inFlight.current = true;
    setIsWorking(true);
    const toast = await showToast({ style: Toast.Style.Animated, title: `Creating ${plan.relativePath}…` });
    let outcome: RemoteOutcome;
    try {
      outcome = await executeCreate(config.root, plan, (step) => {
        toast.message = step;
      });
    } catch (error) {
      // Nothing is left behind locally, so the form stays open for another attempt.
      inFlight.current = false;
      setIsWorking(false);
      toast.style = Toast.Style.Failure;
      toast.title = "Could not create the repository";
      toast.message = errorMessage(error);
      toast.primaryAction = { title: "Copy Error", onAction: () => Clipboard.copy(errorDetails(error)) };
      return;
    }
    showRemoteOutcome(toast, outcome, {
      ...plan,
      verb: "Created",
      doneTitle: "Repository created",
      // A README or license would give the host its own history, which "Publish Branch" cannot push onto.
      createHint: `Create an empty repository ${plan.repoPath} on ${plan.remoteHost}`,
      pushAction: "Publish Branch",
    });
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
        info={
          onGitHub
            ? "Your GitHub user or one of your organizations. Type to use one that does not exist locally yet."
            : "Owner, group, or subgroup below the host. Type to use one that does not exist locally yet."
        }
      >
        {targetDropdownItems(target.namespaceOptions, Icon.Person, "Select a Namespace")}
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
      {onGitHub && (
        <Form.Checkbox
          id="useGitHubCli"
          title="GitHub CLI"
          label="Create it on GitHub with the GitHub CLI (gh)"
          value={useGitHubCli}
          onChange={setUseGitHubCli}
          info="Creates the repository with your gh login and pushes right away. Off: you create it on GitHub yourself, then use “Publish Branch”."
        />
      )}
      {method === "github-cli" && (
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
      <Form.Description title="Created By" text={CREATED_BY[method]} />
      {problem && <Form.Description title="⚠︎" text={problem} />}
    </Form>
  );
}

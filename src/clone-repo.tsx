import { Action, ActionPanel, Clipboard, Form, Icon, LaunchProps, Toast, popToRoot, showToast } from "@raycast/api";
import { useEffect, useMemo, useRef, useState } from "react";
import { forkCreatedBy, forkFormFields, forkWording } from "./components/ForkView";
import { showRemoteOutcome } from "./components/remoteOutcome";
import { targetDropdownItems } from "./components/TargetDropdownItems";
import { useRepoTarget } from "./hooks/useRepoTarget";
import { readCachedIndex, reconcilePath } from "./lib/cache";
import { getConfig } from "./lib/config";
import { PushScope, currentBranch, forkFreshCopy, planFork } from "./lib/fork";
import { cloneRepo, planClone } from "./lib/ops";
import { protocolOf } from "./lib/remotes";
import { placementProblem } from "./lib/targets";
import type { Protocol, Visibility } from "./lib/types";
import { errorDetails, errorMessage } from "./lib/util";

type ProtocolChoice = "as-pasted" | Protocol;

export default function Command(props: LaunchProps<{ arguments: { url?: string } }>) {
  const config = getConfig();
  const [url, setUrl] = useState(props.arguments?.url ?? props.fallbackText ?? "");
  const [choice, setChoice] = useState<ProtocolChoice>("as-pasted");
  const [isCloning, setIsCloning] = useState(false);
  const [urlError, setUrlError] = useState<string>();

  const [fork, setFork] = useState(false);
  const [pushScope, setPushScope] = useState<PushScope>("all");
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [useGitHubCli, setUseGitHubCli] = useState(false);
  const index = useRef(readCachedIndex(config.root)).current;
  const entries = useMemo(() => index?.entries ?? [], [index]);

  useEffect(() => {
    if (url) return;
    Clipboard.readText().then((text) => {
      if (text && planClone(config.root, text, config.defaultProtocol)) {
        // The user may have started typing while the clipboard read was in flight.
        setUrl((current) => current || text.trim());
      }
    });
    // Only prefill once on mount.
  }, []);

  const plan = useMemo(
    () => planClone(config.root, url, config.defaultProtocol, choice === "as-pasted" ? undefined : choice),
    [config.root, config.defaultProtocol, url, choice],
  );

  const sourceHost = plan?.relativePath.split("/")[0];
  const target = useRepoTarget(entries, sourceHost);
  const hostTouched = useRef(false);
  useEffect(() => {
    // The pasted URL decides the default fork target until the user overrides the host.
    if (!hostTouched.current) target.reset(sourceHost);
  }, [sourceHost]);

  const forkPlan = useMemo(() => {
    if (!fork || !plan) return undefined;
    return planFork(config, {
      host: target.host,
      namespace: target.namespace,
      name: plan.relativePath.split("/").pop() ?? "",
      protocol: choice === "as-pasted" ? config.defaultProtocol : choice,
      upstreamUrl: plan.url,
      pushScope,
      visibility,
      useGitHubCli,
    });
  }, [fork, plan, config, target.host, target.namespace, choice, pushScope, visibility, useGitHubCli]);

  const forkFields = forkFormFields(target.host, target.namespace, plan?.url, useGitHubCli);
  const forkProblem = forkPlan && placementProblem(config, entries, forkPlan.targetRelativePath);
  // A second submit while one runs would race it (see CreateRepoForm).
  const inFlight = useRef(false);

  const submit = async () => {
    if (inFlight.current) return;
    if (!plan) {
      setUrlError("Enter a git URL or a bare path like github.com/owner/repo.");
      return;
    }
    if (fork && !forkPlan) {
      setUrlError(forkFields.incompleteError);
      return;
    }
    if (forkProblem) {
      setUrlError(forkProblem);
      return;
    }
    const destination = forkPlan?.targetDestination ?? plan.destination;
    const relativePath = forkPlan?.targetRelativePath ?? plan.relativePath;

    inFlight.current = true;
    setIsCloning(true);
    const toast = await showToast({ style: Toast.Style.Animated, title: `Cloning ${relativePath}…` });
    try {
      await cloneRepo({ ...plan, destination, relativePath });
      if (forkPlan) {
        toast.title = `Forking to ${relativePath}…`;
        const branch = await currentBranch(destination);
        const outcome = await forkFreshCopy(config.root, destination, forkPlan, branch, (step) => {
          toast.message = step;
        });
        showRemoteOutcome(toast, outcome, forkWording(forkPlan));
      } else {
        toast.style = Toast.Style.Success;
        toast.title = "Cloned";
        toast.message = relativePath;
      }
      if (index) await reconcilePath(index, destination, config.defaultProtocol);
      await popToRoot();
    } catch (error) {
      if (index) await reconcilePath(index, destination, config.defaultProtocol).catch(() => undefined);
      toast.style = Toast.Style.Failure;
      toast.title = forkPlan ? "Fork failed" : "Clone failed";
      toast.message = errorMessage(error);
      toast.primaryAction = { title: "Copy Error", onAction: () => Clipboard.copy(errorDetails(error)) };
    } finally {
      inFlight.current = false;
      setIsCloning(false);
    }
  };

  const effectiveProtocol = plan ? (protocolOf(plan.url) ?? "?") : undefined;
  const location = fork
    ? (forkPlan?.targetRelativePath ?? (plan ? "Pick a host and namespace" : "—"))
    : (plan?.relativePath ?? "—");
  const originUrl = fork ? forkPlan?.targetUrl : plan?.url;

  return (
    <Form
      isLoading={isCloning}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title={fork ? "Clone as Fork" : "Clone Repository"}
            icon={Icon.Download}
            onSubmit={submit}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="url"
        title="Repository URL"
        placeholder="git@github.com:owner/repo.git — or github.com/owner/repo"
        value={url}
        error={urlError}
        onChange={(value) => {
          setUrl(value);
          setUrlError(undefined);
        }}
        autoFocus
      />
      <Form.Dropdown
        id="protocol"
        title="Protocol"
        value={choice}
        onChange={(value) => setChoice(value as ProtocolChoice)}
        info="Bare paths without a protocol use the default protocol from the preferences."
      >
        <Form.Dropdown.Item value="as-pasted" title="As Entered" />
        <Form.Dropdown.Item value="ssh" title="SSH" />
        <Form.Dropdown.Item value="https" title="HTTPS" />
      </Form.Dropdown>
      <Form.Checkbox
        id="fork"
        title="Fork"
        label="Clone as a fork of this repository"
        value={fork}
        onChange={setFork}
        info="Clones straight to your own namespace, keeping the source URL as the upstream remote."
      />
      {fork && (
        <Form.Dropdown
          id="host"
          title="Fork Host"
          value={target.host}
          filtering={false}
          onSearchTextChange={target.setHostQuery}
          onChange={(value) => {
            hostTouched.current = true;
            target.setHost(value);
          }}
          placeholder="Search or type a host"
          info="Type to use a host that has no repositories under the root yet."
        >
          {targetDropdownItems(target.hostOptions, Icon.Globe, "Select a Host")}
        </Form.Dropdown>
      )}
      {fork && (
        <Form.Dropdown
          id="namespace"
          title="Fork Namespace"
          value={target.namespace}
          filtering={false}
          onSearchTextChange={target.setNamespaceQuery}
          onChange={target.setNamespace}
          placeholder="Search or type a namespace"
          info={forkFields.namespaceInfo}
        >
          {targetDropdownItems(target.namespaceOptions, Icon.Person, "Select a Namespace")}
        </Form.Dropdown>
      )}
      {fork && forkFields.showGitHubCli && (
        <Form.Checkbox
          id="useGitHubCli"
          title="GitHub CLI"
          label={forkFields.gitHubCliLabel}
          value={useGitHubCli}
          onChange={setUseGitHubCli}
          info={forkFields.gitHubCliInfo}
        />
      )}
      {fork && forkFields.showPushScope && (
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
      {fork && forkFields.showVisibility && (
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
      <Form.Description title="Destination" text={location} />
      <Form.Description title={fork ? "New Origin" : "Clone From"} text={originUrl ?? "—"} />
      {fork && <Form.Description title={config.upstreamRemoteName} text={plan?.url ?? "—"} />}
      {fork && <Form.Description title="Created By" text={forkCreatedBy(forkPlan)} />}
      {forkProblem && <Form.Description title="⚠︎" text={forkProblem} />}
      {!fork && <Form.Description title="Protocol" text={effectiveProtocol ?? "—"} />}
    </Form>
  );
}

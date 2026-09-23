import {
  Action,
  ActionPanel,
  Clipboard,
  Form,
  Icon,
  LaunchProps,
  Toast,
  open,
  popToRoot,
  showToast,
} from "@raycast/api";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForkTarget } from "./hooks/useForkTarget";
import { readCachedIndex, reconcilePath } from "./lib/cache";
import { getConfig } from "./lib/config";
import {
  ForkPushError,
  PushScope,
  createRepoUrl,
  currentBranch,
  materializeTrackingBranches,
  planFork,
  pushFork,
  rewireForFork,
} from "./lib/fork";
import { cloneRepo, planClone } from "./lib/ops";
import { protocolOf } from "./lib/remotes";
import type { Protocol } from "./lib/types";
import { errorMessage } from "./lib/util";

type ProtocolChoice = "as-pasted" | Protocol;

export default function Command(props: LaunchProps<{ arguments: { url?: string } }>) {
  const config = getConfig();
  const [url, setUrl] = useState(props.arguments?.url ?? props.fallbackText ?? "");
  const [choice, setChoice] = useState<ProtocolChoice>("as-pasted");
  const [isCloning, setIsCloning] = useState(false);
  const [urlError, setUrlError] = useState<string>();

  const [fork, setFork] = useState(false);
  const [pushScope, setPushScope] = useState<PushScope>("all");
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
  const target = useForkTarget(entries, sourceHost);
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
    });
  }, [fork, plan, config, target.host, target.namespace, choice, pushScope]);

  const submit = async () => {
    if (!plan) {
      setUrlError("Enter a git URL or a bare path like github.com/owner/repo.");
      return;
    }
    if (fork && !forkPlan) {
      setUrlError("Pick a host and namespace for the fork.");
      return;
    }
    const destination = forkPlan?.targetDestination ?? plan.destination;
    const relativePath = forkPlan?.targetRelativePath ?? plan.relativePath;

    setIsCloning(true);
    const toast = await showToast({ style: Toast.Style.Animated, title: `Cloning ${relativePath}…` });
    try {
      await cloneRepo({ ...plan, destination, relativePath });
      if (forkPlan) {
        toast.title = `Forking to ${relativePath}…`;
        const branch = await currentBranch(destination);
        // Local branches must exist before origin is repointed, otherwise push --all has nothing.
        if (forkPlan.pushScope === "all") await materializeTrackingBranches(destination, branch);
        await rewireForFork(destination, forkPlan);
        await pushFork(destination, forkPlan.pushScope, forkPlan.targetUrl, branch);
      }
      if (index) await reconcilePath(index, destination, config.defaultProtocol);
      toast.style = Toast.Style.Success;
      toast.title = forkPlan ? "Forked" : "Cloned";
      toast.message = relativePath;
      await popToRoot();
    } catch (error) {
      if (index) await reconcilePath(index, destination, config.defaultProtocol).catch(() => undefined);
      toast.style = Toast.Style.Failure;
      toast.message = errorMessage(error);
      if (error instanceof ForkPushError) {
        const createUrl = createRepoUrl(error.targetUrl);
        toast.title = "Cloned, but the fork could not be pushed";
        if (createUrl) toast.primaryAction = { title: "Create the Repository", onAction: () => open(createUrl) };
      } else {
        toast.title = "Clone failed";
      }
    } finally {
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
          onChange={(value) => {
            hostTouched.current = true;
            target.setHost(value);
          }}
        >
          {target.hosts.map((host) => (
            <Form.Dropdown.Item key={host} value={host} title={host} icon={Icon.Globe} />
          ))}
        </Form.Dropdown>
      )}
      {fork && (
        <Form.Dropdown
          id="namespace"
          title="Fork Namespace"
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
      )}
      {fork && (
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
      <Form.Separator />
      <Form.Description title="Destination" text={location} />
      <Form.Description title={fork ? "New Origin" : "Clone From"} text={originUrl ?? "—"} />
      {fork && <Form.Description title={config.upstreamRemoteName} text={plan?.url ?? "—"} />}
      {!fork && <Form.Description title="Protocol" text={effectiveProtocol ?? "—"} />}
    </Form>
  );
}

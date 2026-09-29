import { useCallback, useMemo, useRef, useState } from "react";
import { getConfig, getHostRules } from "../lib/config";
import { initialTarget, knownNamespaces, targetHostOptions, targetOptions, type TargetOption } from "../lib/targets";
import type { RepoEntry } from "../lib/types";

export interface RepoTargetState {
  host: string;
  namespace: string;
  /** Selecting a host always re-applies that host's default namespace (or clears it). */
  setHost: (host: string) => void;
  setNamespace: (namespace: string) => void;
  /** Text typed into the host dropdown's search field: filters the options and is offered as one. */
  setHostQuery: (query: string) => void;
  /** Text typed into the namespace dropdown's search field: filters the options and is offered as one. */
  setNamespaceQuery: (query: string) => void;
  /** Re-apply the preselection for a (possibly newly known) source host. */
  reset: (sourceHost?: string) => void;
  hostOptions: TargetOption[];
  namespaceOptions: TargetOption[];
}

/**
 * Shared state of the host/namespace pair in the forms that pick where a repository goes. Options come
 * from the structures already present under the root, so GitLab subgroups are offered without extra
 * configuration. A dropdown that passes one of the query setters as `onSearchTextChange` must also pass
 * `filtering={false}` (see `targetOptions`).
 */
export function useRepoTarget(entries: RepoEntry[], sourceHost?: string): RepoTargetState {
  const config = useRef(getConfig()).current;
  const initial = useRef(initialTarget(config, sourceHost)).current;
  const [host, setHostState] = useState(initial.host);
  const [namespace, setNamespaceState] = useState(initial.namespace);
  const [hostQuery, setHostQuery] = useState("");
  const [namespaceQuery, setNamespaceQuery] = useState("");

  // A pick ends the search: a query left behind would keep filtering the next time the dropdown opens.
  const setNamespace = useCallback((next: string) => {
    setNamespaceState(next);
    setNamespaceQuery("");
  }, []);

  const setHost = useCallback(
    (next: string) => {
      setHostState(next);
      setHostQuery("");
      // A namespace only ever belongs to one host, so never carry it across.
      setNamespace(config.defaultNamespaces.get(next) ?? "");
    },
    [config, setNamespace],
  );

  const reset = useCallback(
    (nextSourceHost?: string) => {
      const target = initialTarget(config, nextSourceHost);
      setHostState(target.host);
      setHostQuery("");
      setNamespace(target.namespace);
    },
    [config, setNamespace],
  );

  const namespacesByHost = useMemo(() => knownNamespaces(entries), [entries]);

  const hostOptions = useMemo(() => {
    const known = targetHostOptions(entries, config, getHostRules().aliasToReal.keys());
    if (sourceHost && !known.includes(sourceHost)) known.push(sourceHost);
    return targetOptions(known.sort(), host, hostQuery.trim().toLowerCase());
  }, [entries, config, sourceHost, host, hostQuery]);

  const namespaceOptions = useMemo(
    () => targetOptions(namespacesByHost.get(host) ?? [], namespace, namespaceQuery.trim().replace(/^\/+|\/+$/g, "")),
    [namespacesByHost, host, namespace, namespaceQuery],
  );

  return {
    host,
    namespace,
    setHost,
    setNamespace,
    setHostQuery,
    setNamespaceQuery,
    reset,
    hostOptions,
    namespaceOptions,
  };
}

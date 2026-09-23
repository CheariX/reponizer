import { useCallback, useMemo, useRef, useState } from "react";
import { getConfig, getHostRules } from "../lib/config";
import { forkHostOptions, initialForkTarget, knownNamespaces } from "../lib/fork";
import type { RepoEntry } from "../lib/types";

export interface ForkTargetState {
  host: string;
  namespace: string;
  /** Selecting a host always re-applies that host's default namespace (or clears it). */
  setHost: (host: string) => void;
  setNamespace: (namespace: string) => void;
  /** Free text typed into the namespace dropdown; offered as an extra option. */
  setNamespaceQuery: (query: string) => void;
  /** Re-apply the preselection for a (possibly newly known) source host. */
  reset: (sourceHost?: string) => void;
  hosts: string[];
  namespaceOptions: string[];
}

/**
 * Shared state of the host/namespace pair in the fork forms. Options come from the structures
 * already present under the root, so GitLab subgroups are offered without extra configuration.
 */
export function useForkTarget(entries: RepoEntry[], sourceHost?: string): ForkTargetState {
  const config = useRef(getConfig()).current;
  const initial = useRef(initialForkTarget(config, sourceHost)).current;
  const [host, setHostState] = useState(initial.host);
  const [namespace, setNamespace] = useState(initial.namespace);
  const [query, setQuery] = useState("");

  const setHost = useCallback(
    (next: string) => {
      setHostState(next);
      // A namespace only ever belongs to one host, so never carry it across.
      setNamespace(config.defaultForkNamespaces.get(next) ?? "");
    },
    [config],
  );

  const reset = useCallback(
    (nextSourceHost?: string) => {
      const target = initialForkTarget(config, nextSourceHost);
      setHostState(target.host);
      setNamespace(target.namespace);
    },
    [config],
  );

  const namespacesByHost = useMemo(() => knownNamespaces(entries), [entries]);

  const hosts = useMemo(() => {
    const options = forkHostOptions(entries, config, getHostRules().aliasToReal.keys());
    for (const extra of [sourceHost, host]) {
      if (extra && !options.includes(extra)) options.push(extra);
    }
    return options.sort();
  }, [entries, config, sourceHost, host]);

  const namespaceOptions = useMemo(() => {
    const options = [...(namespacesByHost.get(host) ?? [])];
    const typed = query.trim().replace(/^\/+|\/+$/g, "");
    for (const extra of [namespace, typed]) {
      if (extra && !options.includes(extra)) options.push(extra);
    }
    return options;
  }, [namespacesByHost, host, namespace, query]);

  return { host, namespace, setHost, setNamespace, setNamespaceQuery: setQuery, reset, hosts, namespaceOptions };
}

import { Application, getPreferenceValues } from "@raycast/api";
import os from "node:os";
import path from "node:path";
import type { Protocol } from "./types";

interface Preferences {
  reposRoot?: string;
  defaultProtocol?: Protocol;
  scanDepth?: string;
  networkConcurrency?: string;
  hostAliases?: string;
  hostOnlyHosts?: string;
  pushToCreateHosts?: string;
  upstreamRemoteName?: string;
  // Named before repository creation shared it; renaming the key would drop saved values.
  defaultForkNamespaces?: string;
  editorApp?: Application;
  terminalApp?: Application;
}

export interface Config {
  root: string;
  maxDepth: number;
  networkConcurrency: number;
  defaultProtocol: Protocol;
  /** Remote name that marks a repo as a fork, e.g. "upstream". */
  upstreamRemoteName: string;
  /** Canonical (alias-space) host → default namespace below it (fork/create forms), in preference order. */
  defaultNamespaces: Map<string, string>;
  editorApp?: Application;
  terminalApp?: Application;
}

export function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export interface HostRules {
  /** Folder alias under the root → real remote host, both lowercased (e.g. "buw" → "git.uni-wuppertal.de"). */
  aliasToReal: Map<string, string>;
  /** Real remote host → folder alias (inverse of aliasToReal; the first alias for a host wins). */
  realToAlias: Map<string, string>;
  /** Canonical (alias-space) hosts whose repos are compared by host identity only. */
  hostOnly: Set<string>;
  /** Canonical (alias-space) hosts that create a repository when the first push arrives. */
  pushToCreate: Set<string>;
}

// Same shape as the remote-name guard: no leading dash, so these values can never be read as git flags.
export const HOST_TOKEN = /^[A-Za-z0-9][\w.-]*$/;

export const DEFAULT_UPSTREAM_REMOTE = "upstream";

function splitList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function parseHostRules(
  aliasesRaw: string | undefined,
  hostOnlyRaw: string | undefined,
  pushToCreateRaw: string | undefined,
): HostRules {
  const aliasToReal = new Map<string, string>();
  const realToAlias = new Map<string, string>();
  for (const pair of splitList(aliasesRaw)) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const alias = pair.slice(0, eq).trim();
    const real = pair.slice(eq + 1).trim();
    if (!HOST_TOKEN.test(alias) || !HOST_TOKEN.test(real) || alias === real) continue;
    if (!aliasToReal.has(alias)) aliasToReal.set(alias, real);
    if (!realToAlias.has(real)) realToAlias.set(real, alias);
  }
  // Accept alias or real host; store in alias space.
  const hostSet = (raw: string | undefined) =>
    new Set(
      splitList(raw)
        .filter((entry) => HOST_TOKEN.test(entry))
        .map((entry) => realToAlias.get(entry) ?? entry),
    );
  return { aliasToReal, realToAlias, hostOnly: hostSet(hostOnlyRaw), pushToCreate: hostSet(pushToCreateRaw) };
}

let hostRulesCache: { key: string; rules: HostRules } | undefined;

/** Parsed host alias / host-only / push-to-create preferences; memoized per raw preference value. */
export function getHostRules(): HostRules {
  const prefs = getPreferenceValues<Preferences>();
  const key = [prefs.hostAliases, prefs.hostOnlyHosts, prefs.pushToCreateHosts].map((v) => v ?? "").join("\u0000");
  if (hostRulesCache?.key !== key) {
    hostRulesCache = {
      key,
      rules: parseHostRules(prefs.hostAliases, prefs.hostOnlyHosts, prefs.pushToCreateHosts),
    };
  }
  return hostRulesCache.rules;
}

/**
 * Every path segment must pass the same guard as host and remote names, so a namespace
 * from the preferences can never be read as a git flag.
 */
export function isSafePathSegments(value: string): boolean {
  const segments = value.split("/");
  return segments.length > 0 && segments.every((segment) => HOST_TOKEN.test(segment));
}

/**
 * Parse `host=namespace` pairs. Unlike the host rules the value keeps its case —
 * lowercasing would mangle namespaces like "MyOrg/SubGroup".
 */
function parseDefaultNamespaces(raw: string | undefined, rules: HostRules): Map<string, string> {
  const result = new Map<string, string>();
  for (const pair of (raw ?? "").split(",")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const host = pair.slice(0, eq).trim().toLowerCase();
    const namespace = pair
      .slice(eq + 1)
      .trim()
      .replace(/^\/+|\/+$/g, "");
    if (!HOST_TOKEN.test(host) || !namespace || !isSafePathSegments(namespace)) continue;
    const canonical = rules.realToAlias.get(host) ?? host; // accept alias or real host
    if (!result.has(canonical)) result.set(canonical, namespace);
  }
  return result;
}

export function getConfig(): Config {
  const prefs = getPreferenceValues<Preferences>();
  const root = path.resolve(expandTilde(prefs.reposRoot?.trim() || "~/repos"));
  const maxDepth = Number.parseInt(prefs.scanDepth ?? "4", 10) || 4;
  const networkConcurrency = Number.parseInt(prefs.networkConcurrency ?? "4", 10) || 4;
  const upstreamName = prefs.upstreamRemoteName?.trim() ?? "";
  return {
    root,
    maxDepth,
    networkConcurrency,
    defaultProtocol: prefs.defaultProtocol === "https" ? "https" : "ssh",
    upstreamRemoteName: HOST_TOKEN.test(upstreamName) ? upstreamName : DEFAULT_UPSTREAM_REMOTE,
    defaultNamespaces: parseDefaultNamespaces(prefs.defaultForkNamespaces, getHostRules()),
    editorApp: prefs.editorApp,
    terminalApp: prefs.terminalApp,
  };
}

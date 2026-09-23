/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** Repositories Root - Folder containing all repositories, organized as host/owner/repo (git-get layout). */
  "reposRoot": string,
  /** Default Protocol - Protocol used when cloning bare paths (e.g. github.com/owner/repo) and when suggesting origin URLs. */
  "defaultProtocol": "ssh" | "https",
  /** Max Scan Depth - How many folder levels below the root to search for repositories. 3 covers host/owner/repo; increase for GitLab subgroups. */
  "scanDepth": "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10",
  /** Network Concurrency - How many repositories Fetch All / Pull All sync at the same time. Higher values finish faster but put more load on the SSH agent (e.g. 1Password) and the network. */
  "networkConcurrency": "1" | "2" | "4" | "6" | "8" | "12" | "16",
  /** Host Aliases - Comma-separated alias=host pairs mapping a folder name under the root to the real remote host, e.g. “buw=git.uni-wuppertal.de, overleaf.com=git.overleaf.com”. Aliases may be any folder name. */
  "hostAliases"?: string,
  /** Host-Only Comparison - Comma-separated hosts (alias or real host) whose repos are audited by host only — the folder path below the host may differ from the remote path (e.g. Overleaf’s opaque project IDs). */
  "hostOnlyHosts"?: string,
  /** Upstream Remote - Name of the remote that marks a repository as a fork and is used by “Sync from Upstream”. */
  "upstreamRemoteName": string,
  /** Default Fork Namespaces - Comma-separated host=namespace pairs preselected when forking, e.g. “gitlab.com=me/subgroup, github.com=MyUser”. Switching the host in the fork form picks that host’s namespace; hosts without an entry start empty. */
  "defaultForkNamespaces"?: string,
  /** Editor - Application used by the “Open in Editor” action. */
  "editorApp"?: import("@raycast/api").Application,
  /** Terminal - Application used by the “Open in Terminal” action. Terminal.app, iTerm2, kitty, Alacritty, WezTerm, Ghostty, and Warp all open in the repository folder. */
  "terminalApp"?: import("@raycast/api").Application
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `search-repos` command */
  export type SearchRepos = ExtensionPreferences & {}
  /** Preferences accessible in the `clone-repo` command */
  export type CloneRepo = ExtensionPreferences & {}
  /** Preferences accessible in the `fetch-all` command */
  export type FetchAll = ExtensionPreferences & {}
  /** Preferences accessible in the `pull-all` command */
  export type PullAll = ExtensionPreferences & {}
  /** Preferences accessible in the `export-repos` command */
  export type ExportRepos = ExtensionPreferences & {}
  /** Preferences accessible in the `import-repos` command */
  export type ImportRepos = ExtensionPreferences & {}
  /** Preferences accessible in the `menubar-status` command */
  export type MenubarStatus = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `search-repos` command */
  export type SearchRepos = {}
  /** Arguments passed to the `clone-repo` command */
  export type CloneRepo = {
  /** Repository URL */
  "url": string
}
  /** Arguments passed to the `fetch-all` command */
  export type FetchAll = {}
  /** Arguments passed to the `pull-all` command */
  export type PullAll = {}
  /** Arguments passed to the `export-repos` command */
  export type ExportRepos = {}
  /** Arguments passed to the `import-repos` command */
  export type ImportRepos = {}
  /** Arguments passed to the `menubar-status` command */
  export type MenubarStatus = {}
}


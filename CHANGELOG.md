# Reponizer Changelog

## [Sorting] - {PR_MERGE_DATE}

- Sort by (`⌥⌘S`): besides the grouped path order (still the default), show all repositories as one list sorted by last activity, name, or size; the choice is remembered
- Last Activity puts the most recently worked-on repositories first: the later of the last commit and the last time HEAD moved (commit, checkout, pull, …), shown next to each repository; offloaded ones count from when they were offloaded

## [Terminal Tabs] - {PR_MERGE_DATE}

- Open in Terminal (`⌘T`) adds a tab to the terminal's open window instead of always opening a new window, in Terminal.app, Ghostty, and Warp (as iTerm2 already did); without an open window, it opens one. kitty, Alacritty, and WezTerm still open a new window

## [Create Repository] - {PR_MERGE_DATE}

- Create Repository: a new command and list action (`⌘N`) that sets up a new repository as an empty local copy in the right folder, with `origin` pointing at it and one empty initial commit; places the list would not find (inside another repository, deeper than the scan depth) are refused
- Every host works the same: hosts listed in the new "Push-to-Create Hosts" preference are pushed right away; anywhere else, or when that fails, you create the empty repository on the host's website (one click away) and push with Publish Branch
- For GitHub targets, a "GitHub CLI" checkbox opts in to creating the repository as private or public with the GitHub CLI (`gh`) and pushing right away
- Fork to… and Clone as Fork follow the same rules and push with Push to Origin; with the GitHub CLI opted into, forking someone else's GitHub repository makes a real GitHub fork. Forking a GitHub repository you already have a fork of stops with a message and changes nothing
- Create and fork both check the host first: a repository with commits at the target stops them before anything changes, and an existing empty repository is simply pushed to
- Publish Branch: push a branch that has never been pushed to `origin` and set it to track the pushed branch
- The notifications of Create Repository, Fork to…, and Push to Origin open the host's website to create a repository by hand instead of guessing its "new repository" page
- The "Default Fork Namespaces" preference is now "Default Namespaces" and also preselects the namespace for new repositories
- Fixed: forking with “Keep the original local copy” and “All Branches and Tags” now also pushes the branches the checkout only tracks from its remote
- Fixed: searching the namespace field of the fork and clone forms (and the host field of the new create form) now filters the list, and text that matches nothing can be picked as a new namespace

## [Git Error Fixes] - {PR_MERGE_DATE}

- Fixed: cloning and forking repositories that use Git LFS no longer fail with "failed to find custom transfer command"
- Fixed: git errors now show the actual failure instead of git's progress output, and "Copy Error" copies the full git output

## [Fork Support] - {PR_MERGE_DATE}

- Fork awareness: repositories with an upstream remote are marked as forks, show how many commits they are behind their upstream, and can be filtered with the new "Forks" and "Forks Behind Upstream" filters
- Sync from Upstream: fast-forward a fork from its upstream, for a single repository or for all forks at once — never a merge
- Fork to…: fork any cloned repository to another host or namespace (`⌘⇧F`), with namespace autocompletion including GitLab subgroups and an optional new repository name; the new fork becomes `origin`, the previous origin is kept as the upstream remote, and the folder moves to its new place (optionally keeping the original checkout)
- Choose how much is pushed to a new fork: all branches and tags, only the current branch, or nothing yet; GitLab and Gitea create the target project on first push, and for GitHub the error message links to the page for creating it
- Clone Repository can now clone directly as a fork
- New preferences: "Upstream Remote" for the remote name that marks a fork, and "Default Fork Namespaces" for a per-host preselected namespace
- Fixed: importing a repository list now restores the extra remotes stored in the export (such as `upstream`) instead of only `origin`

## [Initial Version] - {PR_MERGE_DATE}

- Search Repositories: hierarchical overview grouped by host and owner, search, status filters, and a detail panel
- Repo status at a glance: branch, ahead/behind counts, uncommitted changes, merge conflicts, stashes, and size on disk
- Remote auditing: flags repositories whose `origin` does not match their location, repositories without remotes, and duplicates — with one-key fixes for the origin URL or the folder location
- Remote management: add, edit, rename, and delete remotes, and switch any remote between SSH and HTTPS
- Host aliases: map short folder names such as `buw` to real hosts such as `git.uni-wuppertal.de`, honored by auditing, cloning, relocation, and duplicate detection
- Host-only comparison: audit hosts with opaque repository paths (such as Overleaf project IDs) by host identity alone
- Clone Repository: paste any git URL or a bare `github.com/owner/repo` path and it lands in the right folder, keeping the protocol you pasted
- Fetch All and Pull All: bulk sync with progress and a failure report; pulls are fast-forward only and skip repositories that are dirty, detached, or without an upstream
- Configurable network concurrency for bulk sync, for SSH agents that struggle with parallel connections
- Offload local copies: verify a repository is fully pushed, free its disk space, and keep a placeholder to restore it later
- Export and Import Repository List: mirror the repository list across machines via a JSON file or a Raycast-synced snapshot
- Repository Health: optional menu bar overview of repositories that need attention
- Quick actions: open in editor, terminal, Finder, or on the remote host's website; copy paths and URLs; move repositories to the Trash

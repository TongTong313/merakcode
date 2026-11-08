# Claim workspaces

Tasks default to `worktree` at a Git repository root and `folder` elsewhere. Folder claims copy only their declared input files into `.merak/work/<task>-<member>`. `publish` copies declared outputs into the project's artifact library, stores independent blobs, and emits `artifact.published`. Relative paths and root-confined file access prevent inputs or outputs from escaping their roots. Human approval completes reviewed tasks; successful completion removes the temporary folder without removing published artifacts.

An `inplace` claim holds an exclusive project lease against other inplace and folder claims. Worktree claims can run concurrently. Folder claims share the project lease with other folders. Finishing a claim releases its lease while retaining its workspace for review or rework. Rework reacquires the lease and reuses the same files. A `none` claim creates no directory and uses the read-only tool pool. Waiting for a lease does not block group messages.

A Git group names the repository root. An ordinary directory inside another repository does not inherit that repository. Each claim starts from its task's base commit in `.merak/worktrees/<task>-<member>` on `merak/<task>/<member>`. The manager rejects path-like task or member identifiers and directories that escape the project. Git's common `info/exclude` keeps the worktrees out of project changes.

Workers verify and commit in their own worktree. `request_merge` queues a successful report. One queue per canonical project serializes rebase and fast-forward. A dirty worker, an existing rebase, a dirty checked-out target, or a divergent target is refused. If the target is checked out elsewhere, Git updates that worktree. Otherwise a compare-and-swap ref update preserves the user's selected branch.

A rebase conflict returns the conflicting files and aborts the attempted rebase. The target remains unchanged. The engine creates an ordinary child task for the original member, starting from the original result. Its report goes through the same queue. Successful integration completes both claims; worktrees are removed without force, and result branches remain available. The group check runs after rebase and before fast-forward, with a two-minute timeout and a 64 KiB output limit. Failed checks return the original claim for rework. Installation and worktree reuse are separate later slices.

The tests use real temporary repositories and scripted model providers. They cover two simultaneous workers, serial integration, conflict resolution by the original member, an existing resolution in progress, the user's selected branch, and worktree release.

Git behavior follows the official [worktree](https://git-scm.com/docs/git-worktree), [rebase](https://git-scm.com/docs/git-rebase), [merge](https://git-scm.com/docs/git-merge), and [update-ref](https://git-scm.com/docs/git-update-ref) documentation.

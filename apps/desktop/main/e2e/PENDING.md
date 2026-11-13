# Pending desktop e2e cases

These cases fail today and are not in the `e2e-desktop` job of `.github/workflows/ci.yml`. They are not skipped or
weakened: each one is owned by a slice of `docs/plans/v1-acceptance-review.html` section 9 that makes it pass. When a
slice fixes a case, delete its line here and add the spec to the CI list in the same pull request (the three cases of
`git.spec.ts` and `review.spec.ts` below are excluded in `ci.yml` by `--grep-invert`: remove them from that pattern).
This file is deleted when R25 finishes.

Last measured on 2026-11-12 on Windows, one spec file at a time on the merged tree. Every other spec file in `e2e/`
passes and is in the CI list. The directory-recovery family (branch-recovery, offline-transfer-recovery,
promotion-recovery, directory-recovery, deleted-directory-recovery, nongit-directory-recovery and the seven spec files
that were not run before) passes since three fixes: the sidebar lists a conversation that runs in a worktree or in the
real directory behind a linked folder with that folder; the engine resolves Windows junctions in
`workspace.Canonical`; `file.identity` names a file by the real place of its folder, also for absolute paths.

## Not a defect of the code under test

| Spec                               | Case                                                                                                                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e/conversation-actions.spec.ts` | copies a reply, renames the conversation and shows context usage next to the input (Electron cannot read the system clipboard back on the Windows machine it was developed on; the copy button itself is covered by a component test; Linux CI decides) |

## Not diagnosed

| Spec                 | Case                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e/review.spec.ts` | `a late review list cannot change the selection after switching scope`, `saved old-side feedback reveals and highlights its line…` and `a late Git review snapshot cannot hide a file restored by undo…` each failed in some whole-file runs on Windows (about one run in two, a different case each time) and pass alone three times in a row. The same failures happen with the folder watcher switched off, so they are not caused by it. The failing screenshot shows the review panel not full screen when the test waits for the full-screen region. Not diagnosed; Linux CI decides. |

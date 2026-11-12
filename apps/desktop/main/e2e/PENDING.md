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

## R20 (direct chat with an external product, plan panel)

| Spec                 | Case                                                                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e/direct.spec.ts` | creates and continues a direct external conversation through the existing new-chat page                                                                                                              |
| `e2e/direct.spec.ts` | keeps a refused external chat locked after reconnect and restores its product when enabled                                                                                                           |
| `e2e/direct.spec.ts` | switches to MerakCode only after an explicit acceptance and keeps the external history                                                                                                               |
| `e2e/direct.spec.ts` | can select and send to an external product before configuring a native model                                                                                                                         |
| `e2e/plan.spec.ts`   | a generated plan opens for review and starts execution without a second confirmation (cancelling a run now stops the plan in the engine, covered by a Go test; this spec was not run after that fix) |

## Review feedback after the branch changed

| Spec                               | Case                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e/review-only-recovery.spec.ts` | review-only drafts and comments on an offline volume leave other branches usable (two cases). Branch switching with the volume offline now works (saved feedback in an unreachable folder no longer stops other folders from loading their branches, covered by `features/review/protection.test.ts`). What still fails: after the volume is back and the branch was switched meanwhile, the saved draft shows as a "resume draft" row instead of re-opening its inline text box, because `commentInView` requires the draft's branch to equal the current one. |

## Not diagnosed

| Spec                             | Case                                                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `e2e/branch-editor-race.spec.ts` | a delayed checkout reload does not target a closed editor after the same file is reopened (60 second timeout, not diagnosed) |

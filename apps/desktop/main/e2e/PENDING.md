# Pending desktop e2e cases

These cases fail today and are not in the `e2e-desktop` job of `.github/workflows/ci.yml`. They are not skipped or
weakened: each one is owned by a slice of `docs/plans/v1-acceptance-review.html` section 9 that makes it pass. When a
slice fixes a case, delete its line here and add the spec to the CI list in the same pull request (the three cases of
`git.spec.ts` and `review.spec.ts` below are excluded in `ci.yml` by `--grep-invert`: remove them from that pattern).
This file is deleted when R25 finishes.

Measured on 2026-11-12 on Windows in one full run of all specs of the merged tree: 150 passed, 29 failed. The seven spec
files of the last section were not part of that run. The plugins case was removed together with the plugin module,
which v1.0.0 does not build (section 11 of the acceptance review).

## Failed in the full run of 2026-11-12

### Not a defect of the code under test

| Spec                               | Case                                                                                                                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e/conversation-actions.spec.ts` | copies a reply, renames the conversation and shows context usage next to the input (Electron cannot read the system clipboard back on the Windows machine it was developed on; the copy button itself is covered by a component test; Linux CI decides) |

### R20 (direct chat with an external product, plan panel)

| Spec                 | Case                                                                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e/direct.spec.ts` | creates and continues a direct external conversation through the existing new-chat page                                                                                                              |
| `e2e/direct.spec.ts` | keeps a refused external chat locked after reconnect and restores its product when enabled                                                                                                           |
| `e2e/direct.spec.ts` | switches to MerakCode only after an explicit acceptance and keeps the external history                                                                                                               |
| `e2e/direct.spec.ts` | can select and send to an external product before configuring a native model                                                                                                                         |
| `e2e/plan.spec.ts`   | a generated plan opens for review and starts execution without a second confirmation (cancelling a run now stops the plan in the engine, covered by a Go test; this spec was not run after that fix) |

### R21 (review accept and reject: the engine has repo.diff only)

| Spec                 | Case                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `e2e/git.spec.ts`    | rejecting after an unreviewed push preserves history and undo restores Git review navigation |
| `e2e/git.spec.ts`    | Git selection and all-file index actions preserve working files and pending review           |
| `e2e/review.spec.ts` | a new conversation uses its own committed baseline                                           |

### R22 (sidebar: the conversation menu has Hide but no Delete, `session.delete` exists)

| Spec                           | Case                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `e2e/promotion-delete.spec.ts` | a late first-send response after deletion leaves fresh tabs and drafts usable                           |
| `e2e/promotion-delete.spec.ts` | deleting a failed journal promotion closes its process tree and browser across two restarts             |
| `e2e/promotion-delete.spec.ts` | deleting a failed destination promotion closes its process tree and browser across two restarts         |
| `e2e/promotion-delete.spec.ts` | deleting a failed source cleanup promotion closes its process tree and browser across two restarts      |
| `e2e/promotion-delete.spec.ts` | deleting a failed cancellation record promotion closes its process tree and browser across two restarts |
| `e2e/promotion-delete.spec.ts` | deleting a failed resource cleanup promotion closes its process tree and browser across two restarts    |

### R21 (directory identity and recovery after renamed, deleted or offline folders)

Passed in the tree of the R21 work before the R22 to R24 work was merged into it, so a clash of the two is possible:
branch-recovery (3), offline-transfer-recovery (2), promotion-recovery (1 of 3).

| Spec                                     | Case                                                                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `e2e/branch-recovery.spec.ts`            | a failed first message can move to a worktree while retaining the original conversation                                      |
| `e2e/branch-recovery.spec.ts`            | retrying a lost worktree creation response reuses the created worktree and retains the task draft                            |
| `e2e/branch-recovery.spec.ts`            | retrying a lost session creation response reuses the session and its worktree with the draft intact                          |
| `e2e/offline-transfer-recovery.spec.ts`  | an offline destination transfer preserves drafts and background navigation across two restarts                               |
| `e2e/offline-transfer-recovery.spec.ts`  | an offline source cleanup transfer preserves drafts and background navigation across two restarts                            |
| `e2e/promotion-recovery.spec.ts`         | a failed source cleanup recovers its original owner after process restart                                                    |
| `e2e/deleted-directory-recovery.spec.ts` | a deleted root link recovers its drafts and owners with legacy mapping=false and with mapping=true                           |
| `e2e/nongit-directory-recovery.spec.ts`  | a non-Git root link retarget cannot move legacy edits into its new destination                                               |
| `e2e/nongit-directory-recovery.spec.ts`  | non-Git root links recover legacy drafts and sleeping owners after reload and two restarts (two cases)                       |
| `e2e/review-only-recovery.spec.ts`       | review-only drafts and comments on an offline volume leave other branches usable (two cases)                                 |
| `e2e/branch-editor-race.spec.ts`         | a delayed checkout reload does not target a closed editor after the same file is reopened (60 second timeout, not diagnosed) |

## Not run on the merged tree

These spec files came from the R21 work. They were left out of the merge by mistake and restored afterwards, so the full
run above did not include them. In the R21 tree they gave: browser-terminal, draft-branch, file-identity and
review-terminal-layout passed; directory-recovery failed 3 cases, offline-directory-recovery 1 case and editor-layout
1 of 3 cases (the group case: the new group dialog has no "add members" step any more, the case needs the new flow).

| Spec                                     |
| ---------------------------------------- |
| `e2e/browser-terminal.spec.ts`           |
| `e2e/directory-recovery.spec.ts`         |
| `e2e/draft-branch.spec.ts`               |
| `e2e/editor-layout.spec.ts`              |
| `e2e/file-identity.spec.ts`              |
| `e2e/offline-directory-recovery.spec.ts` |
| `e2e/review-terminal-layout.spec.ts`     |

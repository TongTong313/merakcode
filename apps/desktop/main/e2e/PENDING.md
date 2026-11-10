# Pending desktop e2e cases

These 20 cases fail today and are not in the `e2e-desktop` job of `.github/workflows/ci.yml`. They are not skipped or
weakened: each one is owned by a slice of `docs/plans/v1-acceptance-review.html` section 9 that makes it pass. When a
slice fixes a case, delete its line here and add the spec to the CI list in the same pull request. This file is deleted
when R25 finishes.

Measured on 2026-11-10 on Windows (acceptance review section 1.1). The `settings.spec.ts` case was re-run on 2026-11-11
and still fails the same way (the "Permissions & security" section does not exist in the settings view).

## R20 (restore the desktop settings, conversation actions and onboarding)

| Spec                               | Case                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `e2e/settings-tools.spec.ts`       | MCP: a local server shows its tool count once connected; deleting removes it from config               |
| `e2e/settings-tools.spec.ts`       | skills: installs a skill from a URL into the project; uninstalling deletes its directory               |
| `e2e/settings-tools.spec.ts`       | plugins: a local plugin file shows as loaded; deleting removes it from project config                  |
| `e2e/settings-tools.spec.ts`       | rules: personal rules are saved to global config and sent with the next message; edits and deletes too |
| `e2e/settings-tools.spec.ts`       | rules: project rules: creates a rule file, saves edits to disk, deleting removes the file              |
| `e2e/settings-tools.spec.ts`       | memory: lists, opens and deletes project memories (file and index); auto-remember can be enabled       |
| `e2e/settings-tools.spec.ts`       | invalid config: startup reports how many entries were skipped; settings show the file and entry        |
| `e2e/conversation-actions.spec.ts` | reverting to a message hides it and later ones and reverts files; restore brings all back              |
| `e2e/conversation-actions.spec.ts` | edit and resend replaces the original turn; retry answers the last turn again                          |
| `e2e/conversation-actions.spec.ts` | copies a reply, renames the conversation and shows context usage next to the input                     |
| `e2e/onboarding.spec.ts`           | shows onboarding without a model; skipping shows the input and a no-model notice                       |
| `e2e/settings.spec.ts`             | a permission rule added in settings is saved to project config and removed on delete                   |

## R21 (source control, editor, review panel and moving a conversation to a worktree)

| Spec                             | Case                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------- |
| `e2e/branch-guards.spec.ts`      | an unsubmitted review comment survives panel changes and blocks branch switching                    |
| `e2e/branch-guards.spec.ts`      | unsaved editor contents survive closing the code panel and still block branch switching             |
| `e2e/branch-guards.spec.ts`      | a commit on the same branch preserves the pending review and unsubmitted draft                      |
| `e2e/branch-recovery.spec.ts`    | a failed first message can move to a worktree while retaining the original conversation             |
| `e2e/branch-recovery.spec.ts`    | retrying a lost worktree creation response reuses the created worktree and retains the task draft   |
| `e2e/branch-recovery.spec.ts`    | retrying a lost session creation response reuses the session and its worktree with the draft intact |
| `e2e/branch-editor-race.spec.ts` | a delayed checkout reload does not target a closed editor after the same file is reopened           |
| `e2e/worktree.spec.ts`           | runs a member claim in its own worktree with an alternate project path (fails on Windows only, B17) |

The rules case of `settings-tools.spec.ts` is two tests in the file (`personal` and `project`), so the file holds seven
cases in total.

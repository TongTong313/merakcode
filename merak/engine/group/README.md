# Local group interaction

Human messages receive an immediate `notice.sent` receipt. Messages addressed to active workers and task discussions go directly to those claims. The Leader learns about these deliveries on its next turn. An idle mentioned worker receives a directly assigned task. Discussion before assignment remains attached to the task packet.

The Leader scheduler orders urgent human messages before reports, combines queued progress, and groups adjacent messages from the same person within two seconds. Low-priority events wait up to three seconds; each batch contains at most 30 events. Human input cancels the current model step and emits `turn.preempted` before the next request.

`ask_leader` waits for `message_member` to answer its event ID within the same task thread. `ask_human` ends the Leader turn immediately; the human answer returns as an event. `say` publishes its reply on the group stream. Workers cannot message other workers.

Task queues use priority and assignment order. A task's Leader may change priority or withdraw a queued claim. Each member runs one claim at a time and automatically starts its next claim after reporting. Withdrawn claims retain their event history and can be reassigned.

Tasks marked for review cannot complete or merge before human approval. Rework reuses the original claim, conversation and workspace. Group checks run after rebase and before fast-forward. A failed check leaves the target unchanged and returns its bounded output to the original claim for rework. Successful review queues worktree integration or completes an ordinary task.

The protocol and SDK expose `group.say`, `task.assign`, `task.review`, `task.update`, `task.cancel`, and direct assignment through `task.create`. Tests exercise the engine, real temporary repositories, real process pipes, and the WebSocket protocol with scripted providers.

Approval roles form a hierarchy: owner includes admin, and admin includes approver. The sole local human receives owner when no role is supplied. Routine writes and commands require approver; external or protected writes, deletion and unknown network hosts require admin. Configured merge approval and budget or permission-mode changes require owner. Group notices carry the original request ID, and replies are authorized before the server consumes a pending answer. Named questions go to that human; a higher role may answer on their behalf.

The SDK folds complete group streams into immutable boards and inboxes. Boards include task columns, goal phases, per-member queue positions, progress, merge results and published artifacts. Inboxes separate actionable notices from information, remove answered requests, and replace obsolete review reminders. Both folds reject sequence gaps and ignore duplicate or session-stream events.

The desktop discovers groups through `group.created` and replays their group streams before applying live events. It combines each claim's progress, resolves mentions to member IDs, and scopes task discussion through `group.say`. Member activity comes from active claims and Leader session history; an unstarted claim session does not block group loading. Read sequences for notices addressed to the local human are persisted through the desktop storage bridge.

`group.update` records `group.updated` after checking admin or owner. Clients replace the complete settings object, preserving fields they do not edit. The desktop exposes passive, normal and eager initiative to these roles and folds later updates into both the current group and group list. External repository and file events refresh the visible Git status and review differences. Watcher overload notices render the shared error catalog in the selected language.

`profile.list` returns the builtin defaults and the caller's saved profiles. `profile.save` copies defaults and protects ownership; `member.register` adds an owned profile to a group. `member.test` starts the actual runner in a temporary directory with a 30-second limit and requires a successful report. The temporary directory is a working directory, not a filesystem sandbox. The product catalog's capabilities govern live-message controls.

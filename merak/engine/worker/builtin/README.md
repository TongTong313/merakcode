# Background children

The engine uses the same `runConversation` and `loop.Loop` implementation for parent and child sessions. `Runner.Spawn` returns a child session ID immediately. `wait_child` waits only for a child owned by the current parent; its report is delivered separately once.

Children inherit provider, model, thinking configuration and working directory. Their frozen tool definitions and runtime pool contain only read operations, excluding both child tools. Their configuration has a parent session ID and has no member ID or task claim. Only the `readonly` profile is available in this slice. The task pool's membership rejection is verified when that pool exists in S18.

The runner queues completed reports. `Steer.Poll` reads that queue between model steps. The loop writes `child.started` and `child.finished` to the parent's stream and folds them on the parent's single worker, so child goroutines cannot race its snapshot or interrupt tool-call/result pairing. When the parent is idle, its worker wakes and starts a continuation with the report. The runner does not preempt a model request for a child result.

`session.Fold` records delivered child IDs and inserts each report once. Recovery loads recorded children, reuses a durable `turn.finished` report when available and synthesizes an interrupted report otherwise. The synchronous debug `Chat` helper closes any remaining children on return; persistent sessions support idle continuations.

Parent cancellation cancels both its current turn and existing children. Cancelled reports remain eligible for persistence but do not start another model request until a new user turn arrives. Engine shutdown cancels children and waits for their workers. A later user turn can spawn new children.

Tests exercise actual scripted providers and local HTTP providers, immediate parent progress, waiting, read-only enforcement, nesting prevention, one-time delivery, event replay, stored-report recovery and cancellation.

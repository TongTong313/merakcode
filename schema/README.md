# Shared storage format

The protocol event union keeps built-in payloads strict. The `external.*` registry entry generates an `external.${string}` SDK type and a validator requiring a nonempty suffix without whitespace or NUL. Only this namespace accepts an arbitrary JSON object payload. `event.emit` uses the same validation in Go. Regenerate `protocol.json` and the SDK protocol with `pnpm generate:protocol` after changing event or method definitions.

`store.sql` is the canonical SQLite schema. `pnpm generate:store` embeds its exact SQL in the Go local host. `pnpm check:store` rejects stale generated files.

The local host uses WAL with full synchronous writes. An append is atomic, rejects duplicate IDs, and requires each stream's sequence to start at 1 and remain consecutive. `Read` includes `from`; `Find` combines populated scope fields and type filters, uses exclusive time bounds, and sorts by time, stream, then sequence. A non-positive limit means no limit. Timestamps in SQLite use UTC with nine fractional digits, preserving nanoseconds and chronological text ordering.

A document's initial revision is 0. A successful write increments the stored revision. Every later write must supply the current revision. Metadata listings sort by key and use a literal prefix. Document bodies are SQLite blobs; the JSON protocol represents bytes as Base64. Event payloads remain opaque JSON and can include unknown event types.

The Go contract tests run against the memory and SQLite hosts. `testdata/store.json` supplies the independently specified contents of `go.db` and `typescript.db`, two golden databases that the Go reader must keep reading; `typescript.db` was written by the TypeScript host of earlier versions and is kept as it is. To regenerate an intentional change of `go.db`, remove it, set `MERAK_GENERATE_STORE_GOLDEN=1`, run Go's `TestGoldenDatabases`, unset the variable, then rerun it. Do not regenerate fixtures to hide a reader regression.

`merak serve` is the daemon of the user: it hosts `<root>/data/merak.db` and keeps running when the desktop app closes; `merak stop` (or "Stop background engine" in the tray) ends it. Clients reach it only through the protocol.

Connection information is stored in `<root>/data/engine.json`, which also keeps a second daemon from starting. The root is `MERAKCODE_HOME`, or `~/.merakcode`.

`testdata/session.json` is a conversation fixture produced by the real Go loop and a scripted model provider. It contains the initial snapshot, durable events, and the final Go state. TypeScript tests fold the same events and compare the complete canonical state with that final state. Renderer tests use the events for tool cards and conversation text. To regenerate an intentional event change, set `MERAK_GENERATE_SESSION_GOLDEN=1`, run `go test ./engine/loop -run TestSessionGolden -count=1` inside `merak`, unset the variable, then rerun the Go test and SDK fold tests. Never update the final snapshot by hand.

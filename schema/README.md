# Shared storage format

The protocol event union keeps built-in payloads strict. The `external.*` registry entry generates an `external.${string}` SDK type and a validator requiring a nonempty suffix without whitespace or NUL. Only this namespace accepts an arbitrary JSON object payload. `event.emit` uses the same validation in Go. Regenerate `protocol.json` and the SDK protocol with `pnpm generate:protocol` after changing event or method definitions.

`store.sql` is the canonical SQLite schema. `pnpm generate:store` embeds its exact SQL in the Go local host and the TypeScript SDK. `pnpm check:store` rejects stale generated files.

Both hosts use WAL with full synchronous writes. An append is atomic, rejects duplicate IDs, and requires each stream's sequence to start at 1 and remain consecutive. `Read` includes `from`; `Find` combines populated scope fields and type filters, uses exclusive time bounds, and sorts by time, stream, then sequence. A non-positive limit means no limit. Timestamps in SQLite use UTC with nine fractional digits, preserving nanoseconds and chronological text ordering.

A document's initial revision is 0. A successful write increments the stored revision. Every later write must supply the current revision. Metadata listings sort by key and use a literal prefix. Document bodies are SQLite blobs; the JSON protocol represents bytes as Base64. Event payloads remain opaque JSON and can include unknown event types.

The Go contract tests run against memory, remote protocol, and SQLite hosts. The TypeScript contract tests cover the same behavior. `testdata/store.json` supplies the independently specified contents of `go.db` and `typescript.db`. Both languages read both golden databases. To regenerate an intentional fixture change, remove only these two generated database files, set `MERAK_GENERATE_STORE_GOLDEN=1`, run Go's `TestGoldenDatabases` and the SDK's `test/store-golden.test.ts`, unset the variable, then rerun both tests. Do not regenerate fixtures to hide a reader regression.

The SDK uses `better-sqlite3` 13.0.3 under the design's fallback rule. Electron 44.9.0 was checked directly and reports Node 24.22.0. That Node version marks `node:sqlite` as [release candidate, stability 1.2](https://raw.githubusercontent.com/nodejs/node/v24.22.0/doc/api/sqlite.md), rather than stable. The same better-sqlite3 package was exercised in Node 26.12.0 and Electron 44.9.0 on Windows. The Go host uses the design's pure-Go [modernc.org/sqlite](https://pkg.go.dev/modernc.org/sqlite) driver without cgo.

`merak serve` hosts `<data>/merak.db` by default. `merak serve --store remote` waits for the first client's storage capability; later storage offers are declined. Clients still use the accepted connection for ordinary session requests. Storage buffering and crash reconciliation belong to S11.

Connection information is stored in `<data>/engine.json`. `MERAKCODE_HOME` overrides the data directory. Defaults are `%APPDATA%\MerakCode` on Windows, `~/Library/Application Support/MerakCode` on macOS, and `$XDG_DATA_HOME/merakcode` or `~/.local/share/merakcode` on Linux.

`testdata/session.json` is a conversation fixture produced by the real Go loop and a scripted model provider. It contains the initial snapshot, durable events, and the final Go state. TypeScript tests fold the same events and compare the complete canonical state with that final state. Renderer tests use the events for tool cards and conversation text. To regenerate an intentional event change, set `MERAK_GENERATE_SESSION_GOLDEN=1`, run `go test ./engine/loop -run TestSessionGolden -count=1` inside `merak`, unset the variable, then rerun the Go test and SDK fold tests. Never update the final snapshot by hand.

# Changelog

All notable changes to MerakCode are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

The first public release.

### Added

- `merak`: terminal UI, `merak run` for one-off tasks, `merak serve` to run only the engine and `merak attach` to connect to it.
- Desktop app for Windows, macOS and Linux, with the engine built in. It checks for updates and installs them where the platform allows (unsigned macOS builds and the Linux deb point to the download page instead).
- TypeScript SDK `@merakcode/sdk`: start or connect to an engine, run sessions, handle approvals and questions, and give the model your own tools.
- Over 200 model providers from the models.dev catalog, plus any OpenAI-compatible API.
- Three permission modes (read-only, ask, auto) with per-project rules.
- An OS sandbox for agent commands on Windows (separate account, NTFS permissions, firewall), Linux (Landlock) and macOS (Seatbelt), with `merak sandbox status|setup|reset`.
- Error codes (`MRK-xxxx`) on every user-facing error, listed in `docs/errors.md`.
- `merak doctor`, `merak logs` and `merak bug-report` for troubleshooting.
- `merak upgrade` (alias `update`) for script and npm installs.
- Chinese and English UI.

// Provides the MerakCode product version to the engine when running from source. Must be the **first import** of
// every process entry point.
//
// The engine's `Installation.VERSION` reads the build-time global MERAKCODE_VERSION and falls back to the engine
// package's own package.json version, which is versioned separately from the CLI. Builds inject the product version and
// never reach this; dev and test processes set the global to the apps/cli version before any engine module evaluates.
import cli from "../package.json"

const scope = globalThis as { MERAKCODE_VERSION?: string }
scope.MERAKCODE_VERSION ??= cli.version

/** Product version, used directly by client code (the terminal UI) without going through the engine. */
export const VERSION: string = scope.MERAKCODE_VERSION

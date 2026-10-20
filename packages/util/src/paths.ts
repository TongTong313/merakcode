/**
 * Directories used by MerakCode (data, cache, config, state, logs). Only computes paths and creates nothing: the
 * engine creates the directories and clears old caches at startup (see global/index.ts in the engine); clients such
 * as the terminal UI only read the paths.
 */
import { xdgCache, xdgConfig, xdgData, xdgState } from "xdg-basedir"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { resolveLogRoot } from "@merakcode/log/node"

const app = "merakcode"

function sanitizePath(input: string): string {
  return input.replace(/\0/g, "")
}

const data = path.join(sanitizePath(xdgData!), app)

export const Paths = {
  // Allow override via MERAKCODE_TEST_HOME for test isolation
  get home() {
    return process.env.MERAKCODE_TEST_HOME || os.homedir()
  },
  data,
  bin: path.join(data, "bin"),
  log: resolveLogRoot(),
  cache: path.join(sanitizePath(xdgCache!), app),
  config: path.join(sanitizePath(xdgConfig!), app),
  state: path.join(sanitizePath(xdgState!), app),
}

/**
 * Global config file: the first existing of merakcode.jsonc and merakcode.json, or merakcode.jsonc when neither
 * exists (where new config is written).
 */
export function globalConfigFile() {
  const candidates = ["merakcode.jsonc", "merakcode.json"].map((file) => path.join(Paths.config, file))
  return candidates.find((file) => existsSync(file)) ?? candidates[0]!
}

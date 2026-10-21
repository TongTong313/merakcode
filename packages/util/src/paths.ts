/**
 * Every directory MerakCode uses lives under one root, ~/.merakcode (MERAKCODE_HOME moves it, for example to another
 * drive). Only computes paths and creates nothing: the engine creates the directories and clears old caches at startup
 * (see global/index.ts in the engine); clients such as the desktop app only read the paths.
 *
 *   <root>/                global config, laid out like a project's .merakcode/: merakcode.json(c), AGENTS.md, skills/
 *   <root>/data/           user data: merakcode.db (conversations and other records), memory, plans, file backups,
 *                          credentials
 *   <root>/worktrees/      git worktrees created for conversations
 *   <root>/logs/           logs
 *   <root>/cache/          anything that can be downloaded or rebuilt: model list, tools, npm packages; cleared when
 *                          the engine's cache version changes
 *   <root>/clients/        state of the desktop app
 *   <root>/versions/, bin/ the installed program (managed by the install scripts)
 */
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { resolveLogRoot } from "@merakcode/log/node"

const root = (process.env.MERAKCODE_HOME || path.join(os.homedir(), ".merakcode")).replace(/\0/g, "")

export const Paths = {
  // Allow override via MERAKCODE_TEST_HOME for test isolation
  get home() {
    return process.env.MERAKCODE_TEST_HOME || os.homedir()
  },
  root,
  config: root,
  data: path.join(root, "data"),
  worktrees: path.join(root, "worktrees"),
  log: resolveLogRoot(),
  cache: path.join(root, "cache"),
  /** Tools downloaded on demand (ripgrep, language servers) */
  bin: path.join(root, "cache", "bin"),
  clients: path.join(root, "clients"),
}

/**
 * Global config file: the first existing of merakcode.jsonc and merakcode.json, or merakcode.jsonc when neither
 * exists (where new config is written).
 */
export function globalConfigFile() {
  const candidates = ["merakcode.jsonc", "merakcode.json"].map((file) => path.join(Paths.config, file))
  return candidates.find((file) => existsSync(file)) ?? candidates[0]!
}

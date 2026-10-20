import type { Plugin } from "vite"
import { compile, runtime, terminal } from "./solid.mjs"

/** Compiles the terminal UI's Solid JSX under Vitest with the same rules as register.mjs; see solid.mjs */
export function solid(): Plugin {
  return {
    name: "merakcode:terminal-solid",
    enforce: "pre",
    config: () => ({
      resolve: {
        alias: Object.entries(runtime).map(([find, replacement]) => ({ find: new RegExp(`^${find}$`), replacement })),
      },
    }),
    transform(code, id) {
      const file = id.split("?")[0]!
      if (!terminal(file)) return
      return { code: compile(code, file), map: null }
    },
  }
}

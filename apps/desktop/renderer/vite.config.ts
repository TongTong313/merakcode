import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { defineConfig, type Plugin } from "vite"
import solid from "vite-plugin-solid"

/** The terminal's ghostty-web loads its wasm from /ghostty-vt.wasm at runtime: served in dev, emitted into dist */
function ghostty(): Plugin {
  const wasm = createRequire(import.meta.url).resolve("ghostty-web/ghostty-vt.wasm")
  return {
    name: "merakcode:ghostty-wasm",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] !== "/ghostty-vt.wasm") return next()
        response.setHeader("Content-Type", "application/wasm")
        response.end(readFileSync(wasm))
      })
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "ghostty-vt.wasm", source: readFileSync(wasm) })
    },
  }
}

export default defineConfig({
  plugins: [solid(), ghostty()],
  worker: { format: "es" },
  build: { target: "esnext", chunkSizeWarningLimit: 4096 },
  server: { port: 3000 },
})

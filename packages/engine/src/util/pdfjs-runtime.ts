import * as path from "path"
import * as fs from "fs"
import { fileURLToPath } from "url"

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs")
type PdfjsWorkerGlobal = typeof globalThis & {
  pdfjsWorker?: {
    WorkerMessageHandler: unknown
  }
}

/** Asset directories (ending in /) that pdfjs reads by file path under Node, passed to getDocument as is */
type Assets = { cMapUrl?: string; standardFontDataUrl?: string; wasmUrl?: string; iccUrl?: string }

let runtime: Promise<{ pdfjs: Pdfjs; assets: Assets }> | undefined

export function loadPdfjsRuntime() {
  return (runtime ??= load())
}

async function load() {
  const [mod, worker] = await silenceOptionalCanvasWarnings(() =>
    Promise.all([import("./pdfjs-bundle"), import("./pdfjs-worker-bundle")]),
  )
  const globals = globalThis as PdfjsWorkerGlobal
  globals.pdfjsWorker = { WorkerMessageHandler: worker.WorkerMessageHandler }
  return { pdfjs: mod.pdfjs, assets: assets() }
}

/**
 * cmaps hold character maps for CJK fonts; standard_fonts are the standard fonts PDFs don't embed (Helvetica and
 * others, as Node has no system fonts to borrow); wasm decodes JPX/JBIG2 images (common in scans); iccs are color
 * profiles. Without one of them the matching text or images cannot be extracted or rendered.
 * The resolved path is the real one (into .pnpm under pnpm); the assets sit in the package root two levels above
 * legacy/build. Paths use forward slashes.
 */
function assets(): Assets {
  const entry = fileURLToPath(import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs"))
  const root = path.resolve(path.dirname(entry), "..", "..")
  const dir = (name: string) => {
    const full = path.join(root, name)
    return fs.existsSync(full) ? full.replace(/\\/g, "/") + "/" : undefined
  }
  return {
    cMapUrl: dir("cmaps"),
    standardFontDataUrl: dir("standard_fonts"),
    wasmUrl: dir("wasm"),
    iccUrl: dir("iccs"),
  }
}

/**
 * In releases canvas does not sit next to pdfjs (it is downloaded into the data directory on demand and the globals
 * are installed beforehand), so pdfjs's warnings about not finding it are expected and must not leak into the
 * terminal UI.
 */
async function silenceOptionalCanvasWarnings<T>(fn: () => Promise<T>) {
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    const msg = typeof args[0] === "string" ? args[0] : ""
    if (isOptionalCanvasWarning(msg)) return
    original(...args)
  }
  try {
    return await fn()
  } finally {
    console.warn = original
  }
}

function isOptionalCanvasWarning(msg: string) {
  return (
    msg.startsWith(`Warning: Cannot load "@napi-rs/canvas" package:`) ||
    msg === "Warning: Cannot polyfill `DOMMatrix`, rendering may be broken." ||
    msg === "Warning: Cannot polyfill `Path2D`, rendering may be broken."
  )
}

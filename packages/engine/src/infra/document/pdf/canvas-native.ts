import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import crypto from "node:crypto"
import { createRequire } from "node:module"
import { gunzipSync } from "node:zlib"
import { Global } from "../../global"

/**
 * On-demand downloader for the canvas (@napi-rs/canvas) native library.
 *
 * The canvas package is a native module (Rust-built skia.<platform>.node plus icudtl.dat, tens of MB per platform).
 * The release does not bundle it (see apps/cli/script/build.ts), so users who never render PDFs don't download it.
 *
 * canvas is only needed when the pdf_parse tool renders PNGs; text extraction and splitting PDFs don't use it. So on
 * first vision use, the @napi-rs/canvas main package and the platform tarball are downloaded into the user data
 * directory: the main package provides the JS wrapper, the platform package provides .node and icudtl.dat. At
 * runtime the official `NAPI_RS_NATIVE_LIBRARY_PATH` variable (highest priority) points at the .node file, and canvas
 * is loaded from the cached main package's index.js. If download, verification or extraction fails, the caller falls
 * back to splitting the PDF.
 *
 * - No new dependencies: gzip via node:zlib gunzipSync, tar via a small hand-written extractor (cross-platform, no
 *   system tar), sha512 via node:crypto, so it all fits in the release bundle.
 * - Pinned version: reads the MERAKCODE_CANVAS_VERSION constant injected by the build (matches pnpm-lock.yaml) rather
 *   than dist-tags.latest, so a canvas upgrade cannot bring an incompatible napi interface.
 * - The cache lives in Global.Path.data (not the cache directory that CACHE_VERSION wipes) and survives restarts.
 */

// Pinned canvas version injected by the build (see the define in apps/cli/script/build.ts).
// Undefined in development, where canvas loads straight from node_modules without a download.
declare const MERAKCODE_CANVAS_VERSION: string | undefined

type CanvasModule = typeof import("@napi-rs/canvas")
type CanvasReady = { ok: true; entry?: string } | { ok: false; reason: string }

const CANVAS_MAIN_PACKAGE = "@napi-rs/canvas"

/** process.platform + process.arch → platform package name + .node file name tag */
const CANVAS_PLATFORM: Record<string, { pkg: string; tag: string }> = {
  "win32:x64": { pkg: "@napi-rs/canvas-win32-x64-msvc", tag: "win32-x64-msvc" },
  "win32:arm64": { pkg: "@napi-rs/canvas-win32-arm64-msvc", tag: "win32-arm64-msvc" },
  "darwin:arm64": { pkg: "@napi-rs/canvas-darwin-arm64", tag: "darwin-arm64" },
  "darwin:x64": { pkg: "@napi-rs/canvas-darwin-x64", tag: "darwin-x64" },
  "linux:x64": { pkg: "@napi-rs/canvas-linux-x64-gnu", tag: "linux-x64-gnu" },
  "linux:arm64": { pkg: "@napi-rs/canvas-linux-arm64-gnu", tag: "linux-arm64-gnu" },
}

/**
 * Makes sure the canvas native library is available.
 *
 * - Development (no version source; node_modules already has @napi-rs/canvas): returns ok and the caller's
 *   `import("@napi-rs/canvas")` resolves from node_modules. Setting the MERAKCODE_CANVAS_VERSION environment variable
 *   in development forces the download path for testing.
 * - Release (version injected by define): downloads the platform tarball into the Global.Path.data cache, extracts
 *   skia.<tag>.node and icudtl.dat, and sets NAPI_RS_NATIVE_LIBRARY_PATH.
 * - Cache present: sets the environment variable and skips the download.
 * - Download, verification or extraction fails: returns { ok: false, reason } so the caller can fall back.
 *
 * This only puts the native library in place and sets the environment variable; it does not import canvas.
 * NAPI_RS_NATIVE_LIBRARY_PATH must be set before canvas is imported.
 *
 * @param onProgress progress callback so the caller can report "downloading…" (e.g. on the tool card via ctx.metadata)
 * @returns { ok: true } on success, { ok: false, reason } on failure
 */
export async function ensureCanvas(onProgress?: (msg: string) => void): Promise<CanvasReady> {
  const platform = CANVAS_PLATFORM[`${process.platform}:${process.arch}`]
  if (!platform) {
    return { ok: false, reason: `unsupported platform: ${process.platform}/${process.arch}` }
  }

  // The version source decides whether to download:
  // - Release: MERAKCODE_CANVAS_VERSION injected by define at build time (see apps/cli/script/build.ts).
  // - Development or tests: an environment variable of the same name triggers the download path.
  // - Normal development: neither is set and canvas is already in node_modules, so no download.
  const version =
    typeof MERAKCODE_CANVAS_VERSION === "string" ? MERAKCODE_CANVAS_VERSION : process.env.MERAKCODE_CANVAS_VERSION
  if (!version) {
    return { ok: true }
  }

  const { pkg, tag } = platform
  // Cached under Global.Path.data, which CACHE_VERSION does not wipe, so it survives restarts.
  // The main package (index.js/js-binding.js) and the platform package (.node/icudtl.dat) are cached separately.
  const cacheRoot = path.join(Global.Path.data, "native", "canvas")
  const jsDir = path.join(cacheRoot, `js@${version}`)
  const nativeDir = path.join(cacheRoot, `${tag}@${version}`)
  const jsEntry = path.join(jsDir, "index.js")
  const nodePath = path.join(nativeDir, `skia.${tag}.node`)

  cleanupStaleCanvasCache(tag, version)

  if (fs.existsSync(jsEntry) && fs.existsSync(nodePath)) {
    process.env.NAPI_RS_NATIVE_LIBRARY_PATH = nodePath
    return { ok: true, entry: jsEntry }
  }

  onProgress?.(`Preparing the PDF vision renderer (@napi-rs/canvas ${version}, ~37MB)…`)

  // Defaults to the npmmirror mirror in mainland China (overridable by environment variable), then the official
  // registry.
  const registries = [
    process.env.MERAKCODE_NPM_REGISTRY || "https://registry.npmmirror.com",
    "https://registry.npmjs.org",
  ]

  try {
    await ensureCachedPackage({
      pkg: CANVAS_MAIN_PACKAGE,
      version,
      destDir: jsDir,
      expectedFile: jsEntry,
      registries,
      label: "PDF vision renderer JS package",
      onProgress,
    })
    await ensureCachedPackage({
      pkg,
      version,
      destDir: nativeDir,
      expectedFile: nodePath,
      registries,
      label: "PDF vision renderer native package (~37MB)",
      onProgress,
    })
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }

  process.env.NAPI_RS_NATIVE_LIBRARY_PATH = nodePath
  onProgress?.(`PDF vision renderer ready, cached at ${cacheRoot}`)
  return { ok: true, entry: jsEntry }
}

/**
 * Removes cached canvas directories of older versions.
 *
 * The cache layout is <data>/native/canvas/<tag>@<version>/. After a canvas upgrade the old directories are no longer
 * used but still take about 37MB each, so every directory with the current tag but another version is deleted
 * (e.g. with tag win32-x64-msvc at 1.0.11, win32-x64-msvc@1.0.10 goes).
 *
 * Other tags (e.g. linux-arm64) belong to other platforms; they are harmless and left alone to avoid deleting the
 * wrong thing. Users can delete native/canvas by hand for a full cleanup.
 *
 * Best effort: errors are ignored and never affect the download.
 */
function cleanupStaleCanvasCache(tag: string, currentVersion: string): void {
  try {
    const canvasRoot = path.join(Global.Path.data, "native", "canvas")
    if (!fs.existsSync(canvasRoot)) return
    const currentDir = `${tag}@${currentVersion}`
    const currentJsDir = `js@${currentVersion}`
    for (const entry of fs.readdirSync(canvasRoot)) {
      if (!entry.startsWith(`${tag}@`) && !entry.startsWith("js@")) continue
      if (entry === currentDir || entry === currentJsDir) continue
      fs.rmSync(path.join(canvasRoot, entry), { recursive: true, force: true })
    }
  } catch {
    // Cleanup failures must not affect the download
  }
}

// Holding the module (even though require is cached) gives direct access to DOMMatrix/ImageData/Path2D for the
// polyfill.
let canvasModule: CanvasModule | null = null
let canvasGlobalsReady = false

/**
 * Prepares the canvas runtime for pdfjs: puts the native library in place (sets NAPI_RS_NATIVE_LIBRARY_PATH),
 * imports canvas without its system fonts (rendering loads them, see loadSystemFonts) and installs
 * DOMMatrix/ImageData/Path2D on globalThis.
 *
 * Why polyfill here: pdfjs-dist's pdf.mjs requires "@napi-rs/canvas" at **module top level** (on import) to install
 * DOMMatrix/ImageData/Path2D on globalThis. That happens once and is not retried at render time. If canvas is not in
 * place when pdfjs loads (NAPI_RS_NATIVE_LIBRARY_PATH unset), the polyfill only warns, globalThis.ImageData stays
 * undefined and rendering crashes with `ReferenceError: ImageData is not defined`.
 *
 * So call this **before any pdfjs import**: it puts the native library in place, then imports canvas and installs the
 * globals. canvas is then available to pdfjs's top-level require, and even if pdfjs's own polyfill misses due to
 * timing, the globals are already there.
 *
 * Idempotent: the module and the polyfill state are cached.
 *
 * @param onProgress download progress callback (only fires on the first download)
 * @returns { ok: true, canvas } with the loaded module on success; { ok: false, reason } on failure, and the caller
 *          decides whether to fall back
 */
export async function prepareCanvasForPdfjs(
  onProgress?: (msg: string) => void,
): Promise<{ ok: true; canvas: CanvasModule } | { ok: false; reason: string }> {
  // Must run before canvas is imported
  const result = await ensureCanvas(onProgress)
  if (!result.ok) return result

  if (!canvasModule) {
    try {
      canvasModule = loadCanvasModule(result.entry)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, reason: `failed to load @napi-rs/canvas: ${message}` }
    }
  }

  // pdfjs does the same at top level but its timing is unreliable, so install the globals before pdfjs loads.
  // canvas's DOMMatrix/ImageData/Path2D differ slightly from the lib.dom types (missing scaleNonUniform, colorSpace and
  // others), but pdfjs only uses the shared subset, hence the `as any`.
  if (!canvasGlobalsReady) {
    const c = canvasModule as any
    if (c?.DOMMatrix && !globalThis.DOMMatrix) globalThis.DOMMatrix = c.DOMMatrix as any
    if (c?.ImageData && !globalThis.ImageData) globalThis.ImageData = c.ImageData as any
    if (c?.Path2D && !globalThis.Path2D) globalThis.Path2D = c.Path2D as any
    canvasGlobalsReady = true
  }

  return { ok: true, canvas: canvasModule }
}

function loadCanvasModule(entry?: string): CanvasModule {
  // On import canvas reads every installed font synchronously, which freezes the engine for seconds on a cold disk,
  // and only rendering needs them (see loadSystemFonts). require is synchronous, so the variable is restored before
  // the engine can start another process that would inherit it.
  const previous = process.env.DISABLE_SYSTEM_FONTS_LOAD
  process.env.DISABLE_SYSTEM_FONTS_LOAD = "1"
  try {
    return createRequire(import.meta.url)(entry ?? CANVAS_MAIN_PACKAGE) as CanvasModule
  } finally {
    if (previous === undefined) delete process.env.DISABLE_SYSTEM_FONTS_LOAD
    else process.env.DISABLE_SYSTEM_FONTS_LOAD = previous
  }
}

let systemFontsLoaded = false

/**
 * Loads the fonts that loadCanvasModule skips: the system fonts and the user font directory canvas would add on
 * import. pdfjs draws text in fonts a PDF does not embed with them, so this runs before the first page is rendered.
 */
export function loadSystemFonts(canvas: CanvasModule) {
  if (systemFontsLoaded) return
  systemFontsLoaded = true
  // canvas calls this on import but leaves it out of its type declarations
  const fonts = canvas.GlobalFonts as CanvasModule["GlobalFonts"] & { loadSystemFonts(): number }
  fonts.loadSystemFonts()
  for (const dir of userFontDirs()) fonts.loadFontsFromDir(dir)
}

function userFontDirs() {
  const home = os.homedir()
  if (process.platform === "win32") return [path.join(home, "AppData", "Local", "Microsoft", "Windows", "Fonts")]
  if (process.platform === "darwin") return [path.join(home, "Library", "Fonts")]
  return ["/usr/local/share/fonts", path.join(home, ".fonts")]
}

async function ensureCachedPackage(opts: {
  pkg: string
  version: string
  destDir: string
  expectedFile: string
  registries: string[]
  label: string
  onProgress?: (msg: string) => void
}) {
  if (fs.existsSync(opts.expectedFile)) return

  let lastError = ""
  for (const registry of opts.registries) {
    try {
      opts.onProgress?.(`Downloading ${opts.label}…`)
      const packument = await fetch(`${registry}/${encodePackageName(opts.pkg)}`).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      const dist = packument?.versions?.[opts.version]?.dist
      if (!dist?.tarball || !dist?.integrity) {
        throw new Error("packument is missing dist.tarball / dist.integrity")
      }

      const tgz = new Uint8Array((await fetch(dist.tarball).then((r) => r.arrayBuffer())) as ArrayBuffer)
      if (!verifyIntegrity(tgz, dist.integrity)) {
        throw new Error("integrity check failed (sha512 mismatch)")
      }

      fs.rmSync(opts.destDir, { recursive: true, force: true })
      fs.mkdirSync(opts.destDir, { recursive: true })
      await extractTgz(tgz, opts.destDir)

      if (!fs.existsSync(opts.expectedFile)) {
        throw new Error(`${path.basename(opts.expectedFile)} not found after extraction`)
      }
      return
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
    }
  }

  throw new Error(`${opts.label} download/verify/extract failed (tried all registries): ${lastError}`)
}

function encodePackageName(pkg: string) {
  return pkg.startsWith("@") ? `@${encodeURIComponent(pkg.slice(1))}` : encodeURIComponent(pkg)
}

/**
 * Verifies a tarball's integrity.
 * @param data tarball bytes
 * @param integrity SRI value such as "sha512-<base64>"
 */
function verifyIntegrity(data: Uint8Array, integrity: string): boolean {
  const [algo, hashB64] = integrity.split("-")
  if (algo !== "sha512" || !hashB64) return false
  const hash = crypto.createHash("sha512").update(Buffer.from(data)).digest("base64")
  return hash === hashB64
}

/**
 * Extracts a .tgz without dependencies: gunzipSync from node:zlib, then a hand-written tar reader.
 *
 * tar is a sequence of 512-byte blocks: each file is a 512-byte header plus data padded to 512, and two zero blocks
 * mark the end. Only regular files (typeflag '0' or '\0') are extracted, with npm's `package/` prefix stripped.
 *
 * No tar library and no system tar command, so it works on Windows, macOS and Linux and can be bundled.
 */
async function extractTgz(tgz: Uint8Array, destDir: string): Promise<void> {
  const tar = gunzipSync(Buffer.from(tgz))
  let offset = 0

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    // Two zero blocks mark the end of the archive
    if (header.every((b) => b === 0)) break

    // Name: bytes[0:100], null-terminated
    const name = readString(header, 0, 100)
    // Size: bytes[124:136], octal ASCII
    const size = parseInt(readString(header, 124, 12).trim(), 8)
    // typeflag: byte[156], '0'/'\0' = regular file, '5' = directory
    const typeflag = String.fromCharCode(header[156])

    offset += 512

    // Regular files only; directories are created when their files are written
    if ((typeflag === "0" || typeflag === "\0") && name) {
      const relPath = name.startsWith("package/") ? name.slice("package/".length) : name
      if (relPath) {
        const outPath = path.join(destDir, relPath)
        fs.mkdirSync(path.dirname(outPath), { recursive: true })
        const fileData = tar.subarray(offset, offset + size)
        fs.writeFileSync(outPath, fileData)
      }
    }

    // Data is padded to 512-byte blocks
    offset += Math.ceil(size / 512) * 512
  }
}

/** Reads a null-terminated ASCII string from a tar header */
function readString(buf: Uint8Array, start: number, len: number): string {
  const slice = buf.subarray(start, start + len)
  const end = slice.indexOf(0)
  return Buffer.from(end === -1 ? slice : slice.subarray(0, end)).toString("ascii")
}

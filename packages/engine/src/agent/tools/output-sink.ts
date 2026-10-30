import { createWriteStream } from "fs"
import { mkdir } from "fs/promises"
import path from "path"
import { Identifier } from "@merakcode/util/id"
import { Truncate } from "./truncation"
import { stripAnsi } from "./lossless/ansi"

type FlowControl = {
  pause: () => void
  resume: () => void
}

export type ToolOutputSink = {
  path: string
  append: (chunk: Buffer | string, flow?: FlowControl) => void
  close: () => Promise<void>
  destroy: () => void
  tail: () => string
}

function metadataTail(text: string, maxBytes: number) {
  return text.length > maxBytes ? "...\n" + text.slice(-maxBytes) : text
}

export async function createToolOutputSink(options?: { maxMetadataLength?: number }): Promise<ToolOutputSink> {
  await mkdir(Truncate.DIR, { recursive: true })
  const outputPath = path.join(Truncate.DIR, Identifier.ascending("tool"))
  const outputFile = createWriteStream(outputPath, { flags: "w" })
  const maxMetadataLength = options?.maxMetadataLength ?? 30_000
  let outputTail = ""

  const streamClosed = new Promise<void>((resolve, reject) => {
    outputFile.once("finish", resolve)
    outputFile.once("error", reject)
  })

  // No writes after close()/destroy(): Node would throw ERR_STREAM_WRITE_AFTER_END, and the error event would
  // reject streamClosed and crash the whole tool call. The bash tool already waits for stdout/stderr to drain; this
  // only catches chunks that arrive after that wait timed out. Dropping them beats crashing, and the tail still keeps
  // them for metadata.
  let ended = false
  // Escape sequences such as terminal colors mean nothing to the model or the UI, so they are stripped before saving.
  // A sequence may be split across two chunks: an unfinished one at the end of a chunk waits for the next chunk.
  let pending = ""
  const write = (text: string, flow?: FlowControl) => {
    outputTail = metadataTail(outputTail + text, maxMetadataLength)
    if (ended || !text) return
    if (outputFile.write(text) || !flow) return
    flow.pause()
    outputFile.once("drain", flow.resume)
  }

  return {
    path: outputPath,
    append: (chunk, flow) => {
      const text = pending + (typeof chunk === "string" ? chunk : chunk.toString())
      const cut = text.match(/\x1b(?:\[[0-9;?]*|\][^\x07\x1b]*)?$/)?.index ?? text.length
      pending = text.slice(cut)
      write(stripAnsi(text.slice(0, cut)), flow)
    },
    close: async () => {
      write(pending)
      pending = ""
      ended = true
      outputFile.end()
      await streamClosed
    },
    destroy: () => {
      ended = true
      outputFile.destroy()
    },
    tail: () => outputTail,
  }
}

export { metadataTail }

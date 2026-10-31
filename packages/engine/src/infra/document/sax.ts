import { Writer } from "@zip.js/zip.js"
import { decodeXml, type ZipEntry } from "./xml"

export type SaxHandler = {
  onOpenTag?: (name: string, attrs: Record<string, string>, selfClosing: boolean) => void
  onText?: (text: string) => void
  onCloseTag?: (name: string) => void
}

/** The stream scan was stopped on purpose (row/char limit reached, range ended, or scan byte limit exceeded) */
class StreamAbortedError extends Error {
  constructor() {
    super("__stream_aborted__")
    this.name = "StreamAbortedError"
  }
}

/**
 * Lightweight incremental XML scanner for the flat structure of xlsx / docx, shared by the excel and docx stream
 * parsers. Dependency-free: a state machine finds tag boundaries character by character, handling tags and multibyte
 * characters split across chunks. Can be aborted early once a limit is hit.
 */
export class StreamingSax {
  private buf = ""
  private pos = 0
  private aborted = false
  private handler: SaxHandler = {}

  constructor(handler?: SaxHandler) {
    if (handler) this.handler = handler
  }

  setHandler(handler: SaxHandler) {
    this.handler = handler
  }

  get isAborted() {
    return this.aborted
  }

  abort() {
    this.aborted = true
  }

  push(chunk: string) {
    if (this.aborted || !chunk) return
    this.buf += chunk
    this.drain()
  }

  /** Signals end of input and flushes the remaining buffer */
  end() {
    if (this.aborted) return
    this.drain()
    this.buf = ""
    this.pos = 0
  }

  private drain() {
    while (!this.aborted) {
      const remaining = this.buf.length - this.pos
      if (remaining <= 0) break

      const lt = this.buf.indexOf("<", this.pos)
      // No more tags: the rest is text
      if (lt === -1) {
        this.handler.onText?.(this.buf.slice(this.pos))
        this.buf = ""
        this.pos = 0
        return
      }
      if (lt > this.pos) {
        this.handler.onText?.(this.buf.slice(this.pos, lt))
      }
      this.pos = lt

      const consumed = this.parseTagAt()
      if (consumed === 0) {
        // Incomplete tag: keep the buffer from here and wait for more data
        if (this.pos > 0) {
          this.buf = this.buf.slice(this.pos)
          this.pos = 0
        }
        return
      }
      this.pos += consumed
    }
    // Drop the consumed prefix so the buffer does not grow without bound
    if (this.pos > 0) {
      this.buf = this.buf.slice(this.pos)
      this.pos = 0
    }
  }

  /** Parses one tag at buf[pos] (expected '<') and returns the characters consumed; 0 means the data is incomplete */
  private parseTagAt(): number {
    const s = this.buf
    const i = this.pos
    const next = s[i + 1]

    // CDATA / comment / DOCTYPE
    if (next === "!") {
      if (s.startsWith("<![CDATA[", i)) {
        const end = s.indexOf("]]>", i + 9)
        if (end === -1) return 0
        this.handler.onText?.(s.slice(i + 9, end))
        return end + 3 - i
      }
      if (s.startsWith("<!--", i)) {
        const end = s.indexOf("-->", i + 4)
        if (end === -1) return 0
        return end + 3 - i
      }
      const end = s.indexOf(">", i)
      if (end === -1) return 0
      return end + 1 - i
    }

    // Processing instruction <?xml ?>
    if (next === "?") {
      const end = s.indexOf("?>", i + 2)
      if (end === -1) return 0
      return end + 2 - i
    }

    // Closing tag </name>
    if (next === "/") {
      const end = s.indexOf(">", i + 2)
      if (end === -1) return 0
      const name = localName(s.slice(i + 2, end).trim())
      this.handler.onCloseTag?.(name)
      return end + 1 - i
    }

    // Opening tag <name attrs> or self-closing <name attrs/>
    const close = this.findTagEnd(i)
    if (close === -1) return 0
    const tagContent = s.slice(i + 1, close)
    const selfClosing = tagContent.endsWith("/")
    const inner = selfClosing ? tagContent.slice(0, -1) : tagContent
    const { name, attrs } = parseOpenTag(inner)
    this.handler.onOpenTag?.(name, attrs, selfClosing)
    if (selfClosing) {
      this.handler.onCloseTag?.(name)
    }
    return close + 1 - i
  }

  /** Finds the '>' that ends the tag, starting at start+1 and skipping quoted values; returns -1 if not found */
  private findTagEnd(start: number): number {
    const s = this.buf
    const n = s.length
    let i = start + 1
    let quote: string | null = null
    while (i < n) {
      const ch = s[i]
      if (quote) {
        if (ch === quote) quote = null
      } else if (ch === '"' || ch === "'") {
        quote = ch
      } else if (ch === ">") {
        return i
      }
      i++
    }
    return -1
  }
}

/** Parses the content of an opening tag (without angle brackets) into its name and attributes */
function parseOpenTag(inner: string): { name: string; attrs: Record<string, string> } {
  const nameMatch = inner.match(/^\s*([^\s/>]+)/)
  const name = localName(nameMatch ? nameMatch[1] : "")
  const attrs: Record<string, string> = {}
  const attrRe = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let m: RegExpExecArray | null
  while ((m = attrRe.exec(inner))) {
    const key = m[1]
    const val = m[2] ?? m[3] ?? ""
    attrs[key] = decodeXml(val)
  }
  return { name, attrs }
}

/** Strips the namespace prefix: `r:id` → `id`, `w:p` → `p` */
function localName(name: string): string {
  const idx = name.lastIndexOf(":")
  return idx === -1 ? name : name.slice(idx + 1)
}

/**
 * zip.js Writer that feeds decompressed chunks through a streaming TextDecoder (which handles multibyte characters
 * split across chunks) into StreamingSax, without building the full string. Throws StreamAbortedError on abort or
 * when the scan byte limit is exceeded, so zip.js stops decompressing early.
 *
 * Extends zip.js's `Writer` base class to get the right `writable` / `init` protocol; data arrives through
 * `writeUint8Array`.
 */
class StreamXmlWriter extends Writer<void> {
  private decoder = new TextDecoder("utf-8")
  private scanned = 0

  constructor(
    private scanner: StreamingSax,
    private maxScanBytes: number,
  ) {
    super()
  }

  override async writeUint8Array(chunk: Uint8Array) {
    // Throwing stops zip.js from decompressing the rest
    if (this.scanner.isAborted) throw new StreamAbortedError()
    this.scanned += chunk.byteLength
    const text = this.decoder.decode(chunk, { stream: true })
    if (text) this.scanner.push(text)
    // The scanner may have aborted itself on a row/char limit
    if (this.scanner.isAborted) throw new StreamAbortedError()
    if (this.scanned > this.maxScanBytes) {
      this.scanner.abort()
      throw new StreamAbortedError()
    }
  }

  override async getData() {
    // Flush the decoder only when not aborted
    if (!this.scanner.isAborted) {
      const tail = this.decoder.decode()
      if (tail) this.scanner.push(tail)
      this.scanner.end()
    }
    return undefined
  }
}

/** Streams one zip part through decompression and scanning; returns ok / aborted / missing */
export async function runStream(
  entry: ZipEntry | undefined,
  scanner: StreamingSax,
  maxScanBytes: number,
): Promise<"ok" | "aborted" | "missing"> {
  if (!entry) return "missing"
  const writer = new StreamXmlWriter(scanner, maxScanBytes)
  try {
    await entry.getData(writer)
    return "ok"
  } catch (error) {
    if (error instanceof StreamAbortedError) return "aborted"
    throw error
  }
}

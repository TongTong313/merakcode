import type { WorkflowMeta, WorkflowPhaseMeta, WorkflowScript } from "./types"

function skipTrivia(source: string) {
  let index = source.charCodeAt(0) === 0xfeff ? 1 : 0
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (/\s/.test(char ?? "")) {
      index++
      continue
    }
    if (char === "/" && next === "/") {
      index += 2
      while (index < source.length && source[index] !== "\n") index++
      continue
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2)
      if (end === -1) return index
      index = end + 2
      continue
    }
    break
  }
  return index
}

function findMatchingBrace(source: string, start: number) {
  let depth = 0
  let quote: '"' | "'" | "`" | undefined
  let escaped = false
  let line = false
  let block = false
  for (let index = start; index < source.length; index++) {
    const char = source[index]!
    const next = source[index + 1]
    if (line) {
      if (char === "\n") line = false
      continue
    }
    if (block) {
      if (char === "*" && next === "/") {
        block = false
        index++
      }
      continue
    }
    if (quote) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === "\\") {
        escaped = true
        continue
      }
      if (char === quote) quote = undefined
      continue
    }
    if (char === "/" && next === "/") {
      line = true
      index++
      continue
    }
    if (char === "/" && next === "*") {
      block = true
      index++
      continue
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char
      continue
    }
    if (char === "{") depth++
    if (char === "}") {
      depth--
      if (depth === 0) return index
    }
  }
  return -1
}

function hasImportOrExport(source: string) {
  let index = 0
  let quote: '"' | "'" | "`" | undefined
  let escaped = false
  let line = false
  let block = false
  while (index < source.length) {
    const char = source[index]!
    const next = source[index + 1]
    if (line) {
      if (char === "\n") line = false
      index++
      continue
    }
    if (block) {
      if (char === "*" && next === "/") {
        block = false
        index += 2
        continue
      }
      index++
      continue
    }
    if (quote) {
      if (escaped) {
        escaped = false
        index++
        continue
      }
      if (char === "\\") {
        escaped = true
        index++
        continue
      }
      if (char === quote) quote = undefined
      index++
      continue
    }
    if (char === "/" && next === "/") {
      line = true
      index += 2
      continue
    }
    if (char === "/" && next === "*") {
      block = true
      index += 2
      continue
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char
      index++
      continue
    }
    const match = /^[A-Za-z_$][\w$]*/.exec(source.slice(index))
    if (match) {
      if (match[0] === "export") return true
      if (match[0] === "import") {
        const rest = source.slice(index + match[0].length).trimStart()
        if (rest.startsWith("(") || rest.startsWith("{") || rest.startsWith("*")) return true
        if (/^["']/.test(rest)) return true
        if (/^[A-Za-z_$]/.test(rest)) return true
      }
      index += match[0].length
      continue
    }
    index++
  }
  return false
}

class LiteralParser {
  private index = 0

  constructor(private readonly source: string) {}

  parse() {
    const value = this.value()
    this.trivia()
    if (this.index !== this.source.length) throw new Error("Workflow meta must be a pure object literal")
    return value
  }

  private value(): unknown {
    this.trivia()
    const char = this.peek()
    if (char === "{") return this.object()
    if (char === "[") return this.array()
    if (char === '"' || char === "'") return this.string()
    if (char === "-" || this.digit(char)) return this.number()
    const ident = this.identifier()
    if (ident === "true") return true
    if (ident === "false") return false
    if (ident === "null") return null
    throw new Error("Workflow meta must contain only literal values")
  }

  private object() {
    const result: Record<string, unknown> = {}
    this.expect("{")
    this.trivia()
    if (this.consume("}")) return result
    while (true) {
      this.trivia()
      if (this.source.startsWith("...", this.index) || this.peek() === "[") {
        throw new Error("Workflow meta cannot use spread or computed keys")
      }
      const key = this.key()
      this.trivia()
      this.expect(":")
      result[key] = this.value()
      this.trivia()
      if (this.consume("}")) return result
      this.expect(",")
      this.trivia()
      if (this.consume("}")) return result
    }
  }

  private array() {
    const result: unknown[] = []
    this.expect("[")
    this.trivia()
    if (this.consume("]")) return result
    while (true) {
      result.push(this.value())
      this.trivia()
      if (this.consume("]")) return result
      this.expect(",")
      this.trivia()
      if (this.consume("]")) return result
    }
  }

  private key() {
    const char = this.peek()
    if (char === '"' || char === "'") return this.string()
    return this.identifier()
  }

  private string() {
    const quote = this.peek()
    if (quote !== '"' && quote !== "'") throw new Error("Expected string")
    this.index++
    let result = ""
    while (this.index < this.source.length) {
      const char = this.source[this.index++]!
      if (char === quote) return result
      if (char === "\\") {
        const escaped = this.source[this.index++]
        if (escaped === undefined) throw new Error("Invalid string escape")
        result += JSON.parse(`"\\${escaped}"`)
        continue
      }
      result += char
    }
    throw new Error("Unterminated string")
  }

  private number() {
    const start = this.index
    if (this.peek() === "-") this.index++
    while (this.digit(this.peek())) this.index++
    if (this.peek() === ".") {
      this.index++
      while (this.digit(this.peek())) this.index++
    }
    const raw = this.source.slice(start, this.index)
    const value = Number(raw)
    if (!Number.isFinite(value)) throw new Error("Invalid number literal")
    return value
  }

  private identifier() {
    const match = /^[A-Za-z_$][\w$]*/.exec(this.source.slice(this.index))
    if (!match) throw new Error("Expected identifier")
    this.index += match[0].length
    return match[0]
  }

  private trivia() {
    while (this.index < this.source.length) {
      const char = this.source[this.index]
      const next = this.source[this.index + 1]
      if (/\s/.test(char ?? "")) {
        this.index++
        continue
      }
      if (char === "/" && next === "/") {
        this.index += 2
        while (this.index < this.source.length && this.source[this.index] !== "\n") this.index++
        continue
      }
      if (char === "/" && next === "*") {
        const end = this.source.indexOf("*/", this.index + 2)
        if (end === -1) throw new Error("Unterminated block comment")
        this.index = end + 2
        continue
      }
      break
    }
  }

  private expect(char: string) {
    if (!this.consume(char)) throw new Error(`Expected ${char}`)
  }

  private consume(char: string) {
    if (this.source[this.index] !== char) return false
    this.index++
    return true
  }

  private peek() {
    return this.source[this.index]
  }

  private digit(char?: string) {
    return char !== undefined && char >= "0" && char <= "9"
  }
}

function normalizePhase(phase: unknown, index: number): WorkflowPhaseMeta {
  if (typeof phase === "string" && phase.trim()) return { title: phase.trim() }
  if (typeof phase === "object" && phase) {
    const item = phase as Record<string, unknown>
    if (typeof item.title === "string" && item.title.trim()) {
      return {
        title: item.title.trim(),
        ...(typeof item.detail === "string" && item.detail.trim() ? { detail: item.detail.trim() } : {}),
        ...(typeof item.model === "string" && item.model.trim() ? { model: item.model.trim() } : {}),
      }
    }
  }
  throw new Error(`Workflow phase ${index + 1} must have a title`)
}

function normalizeConcurrency(meta: Record<string, unknown>) {
  const raw = meta.maxConcurrentAgents ?? meta.concurrency
  if (raw === undefined) return {}
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 1000) {
    throw new Error("Workflow meta.concurrency must be an integer between 1 and 1000")
  }
  return {
    concurrency: raw,
    maxConcurrentAgents: raw,
  }
}

function validate(value: unknown): WorkflowMeta {
  if (typeof value !== "object" || value === null) throw new Error("Workflow meta must be an object literal")
  const meta = value as Record<string, unknown>
  if (typeof meta.name !== "string" || !meta.name.trim())
    throw new Error("Workflow meta.name must be a non-empty string")
  if (typeof meta.description !== "string" || !meta.description.trim()) {
    throw new Error("Workflow meta.description must be a non-empty string")
  }
  if (meta.phases !== undefined && !Array.isArray(meta.phases)) throw new Error("Workflow meta.phases must be an array")
  return {
    name: meta.name.trim(),
    description: meta.description.trim(),
    ...(typeof meta.whenToUse === "string" && meta.whenToUse.trim() ? { whenToUse: meta.whenToUse.trim() } : {}),
    ...normalizeConcurrency(meta),
    phases: Array.isArray(meta.phases) ? meta.phases.map(normalizePhase) : [],
  }
}

export namespace WorkflowScriptParser {
  export function parse(input: {
    script: string
    scriptPath?: string
    source?: WorkflowScript["source"]
  }): WorkflowScript {
    const header = "export const meta"
    const start = skipTrivia(input.script)
    if (!input.script.startsWith(header, start)) {
      throw new Error("Workflow script must begin with `export const meta = { name, description, phases }`")
    }
    let index = start + header.length
    while (/\s/.test(input.script[index] ?? "")) index++
    if (input.script[index] !== "=") throw new Error("Workflow meta export must assign an object literal")
    index++
    while (/\s/.test(input.script[index] ?? "")) index++
    if (input.script[index] !== "{") throw new Error("Workflow meta must be an object literal")
    const end = findMatchingBrace(input.script, index)
    if (end === -1) throw new Error("Workflow meta object is not closed")
    const meta = validate(new LiteralParser(input.script.slice(index, end + 1)).parse())
    let body = input.script.slice(end + 1)
    body = body.replace(/^\s*;?/, "")
    if (hasImportOrExport(body)) {
      throw new Error(
        "Workflow body cannot contain import or export statements. The only allowed export is the leading `export const meta = { ... }`; put executable code directly after meta and use only workflow globals such as agent(), fanout(), pipeline(), parallel(), phase(), log(), args, and budget.",
      )
    }
    if (/\bDate\s*\.\s*now\b|\bMath\s*\.\s*random\b|\bnew\s+Date\s*\(\s*\)/.test(body)) {
      throw new Error(
        "Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable (breaks resume). Stamp results after the workflow returns, or pass timestamps via args.",
      )
    }
    return {
      ...meta,
      script: input.script,
      body,
      scriptPath: input.scriptPath,
      source: input.source ?? "custom",
    }
  }
}

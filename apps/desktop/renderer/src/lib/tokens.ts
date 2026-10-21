import type { ThemedToken } from "shiki/core"
import TokensWorker from "./tokens.worker?worker"

type Reply = { id: number; tokens?: ThemedToken[][] }

let worker: Worker | undefined
let next = 0
const waiting = new Map<number, (tokens: ThemedToken[][] | undefined) => void>()

function start() {
  if (worker) return worker
  worker = new TokensWorker()
  worker.onmessage = (event: MessageEvent<Reply>) => {
    waiting.get(event.data.id)?.(event.data.tokens)
    waiting.delete(event.data.id)
  }
  // A worker that fails to load answers nothing: show the code without colors
  worker.onerror = () => {
    for (const resolve of waiting.values()) resolve(undefined)
    waiting.clear()
  }
  return worker
}

/** Tokens per line, highlighted in a worker: whole files in a diff would otherwise block the UI */
export function tokenize(code: string, lang: string | undefined): Promise<ThemedToken[][] | undefined> {
  if (!lang) return Promise.resolve(undefined)
  const id = next++
  return new Promise((resolve) => {
    waiting.set(id, resolve)
    start().postMessage({ id, code, lang })
  })
}

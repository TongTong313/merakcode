import { highlightLines } from "./highlight"

/** Highlights code off the main thread (see tokens.ts) */
const scope = self as unknown as {
  onmessage: (event: MessageEvent<{ id: number; code: string; lang: string }>) => void
  postMessage: (message: unknown) => void
}

scope.onmessage = async (event) => {
  const { id, code, lang } = event.data
  const tokens = await highlightLines(code, lang).catch(() => undefined)
  scope.postMessage({ id, tokens })
}

import { createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useLocale } from "../context/locale"
import { useTheme } from "../context/theme"
import { RGBA } from "@opentui/core"

const THINKING_WORD_COUNT = 30
const WORD_INTERVAL_MS = 3000

const BREATH_PERIOD_MS = 1600
const BREATH_FRAME_MS = 60
const BREATH_MIN = 0.35
const BREATH_MAX = 1.0
const TWO_PI = Math.PI * 2

export function ThinkingWord() {
  const locale = useLocale()
  const { theme } = useTheme()

  const pick = () => Math.floor(Math.random() * THINKING_WORD_COUNT)
  const [index, setIndex] = createSignal(pick())
  const [phase, setPhase] = createSignal(0)

  onMount(() => {
    const wordTimer = setInterval(() => {
      let next = pick()
      if (next === index()) next = (next + 1) % THINKING_WORD_COUNT
      setIndex(next)
    }, WORD_INTERVAL_MS)

    const breathTimer = setInterval(() => {
      setPhase((p) => (p + (BREATH_FRAME_MS / BREATH_PERIOD_MS) * TWO_PI) % TWO_PI)
    }, BREATH_FRAME_MS)

    onCleanup(() => {
      clearInterval(wordTimer)
      clearInterval(breathTimer)
    })
  })

  const word = createMemo(() => locale.t(`thinking.word.${index()}`))
  const color = createMemo(() => {
    const base = theme.text
    const alpha = BREATH_MIN + (BREATH_MAX - BREATH_MIN) * (Math.sin(phase()) * 0.5 + 0.5)
    return RGBA.fromValues(base.r, base.g, base.b, alpha)
  })

  return <text fg={color()}>✦ {word()}…</text>
}

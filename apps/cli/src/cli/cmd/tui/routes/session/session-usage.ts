import type { AssistantMessage, Message, Provider, Session } from "@merakcode/sdk/client"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

/** IDs of messages hidden by undo, consistent with the main session view. */
export function hiddenMessageIds(session: Session | undefined) {
  const hidden = new Set<string>()
  for (const entry of session?.undoRedo?.stack ?? []) {
    for (const msgID of entry.hiddenMessages) hidden.add(msgID)
  }
  return hidden
}

/**
 * Orders messages by turn causality so that, with concurrent or queued turns, an earlier turn's tool calls and replies
 * never appear below a later user message.
 */
export function sortByTurnCausality(messages: Message[]): Message[] {
  const result: Message[] = []
  const userTurns: Message[] = []
  const turnMap = new Map<string, Message[]>()

  for (const m of messages) {
    if (m.role === "user") {
      userTurns.push(m)
      turnMap.set(m.id, [])
    } else if (
      m.role === "assistant" &&
      (m as AssistantMessage).parentID &&
      turnMap.has((m as AssistantMessage).parentID!)
    ) {
      turnMap.get((m as AssistantMessage).parentID!)!.push(m)
    } else {
      result.push(m)
    }
  }

  const flattened: Message[] = []
  for (const u of userTurns) {
    flattened.push(u)
    const assistants = turnMap.get(u.id)
    if (assistants) {
      flattened.push(...assistants)
    }
  }
  return [...result, ...flattened]
}

/** Messages visible in the main session view: undo-hidden ones removed, ordered by turn causality. */
export function visibleMessages(messages: Message[], session: Session | undefined) {
  const hidden = hiddenMessageIds(session)
  const filtered = messages.filter((m) => !hidden.has(m.id))
  return sortByTurnCausality(filtered)
}

/** Token total, the same as in the AssistantMessage metadata line of the session view. */
export function assistantMessageTokens(message: AssistantMessage) {
  if (!message.tokens) return 0
  return (
    message.tokens.input +
    message.tokens.output +
    message.tokens.reasoning +
    (message.tokens.cache?.read ?? 0) +
    (message.tokens.cache?.write ?? 0)
  )
}

/** Whether the session view treats an assistant message as a completed turn (same as final()). */
export function assistantRoundComplete(message: AssistantMessage) {
  return !!message.finish && !["tool-calls", "unknown"].includes(message.finish)
}

/** Sum of the per-turn costs shown in the session view (visible, completed assistant messages only). */
export function sessionRoundCostTotal(messages: Message[], session: Session | undefined) {
  return visibleMessages(messages, session)
    .filter((m): m is AssistantMessage => m.role === "assistant")
    .filter(assistantRoundComplete)
    .reduce((sum, m) => sum + m.cost, 0)
}

export function contextLimit(providerID: string, modelID: string, providers: Provider[]) {
  return providers.find((x) => x.id === providerID)?.models[modelID]?.limit?.context
}

/**
 * Model name for the assistant metadata line: the display name, as in the model picker and below the prompt, falling
 * back to the raw id when the model is missing from the catalog (e.g. retired).
 */
export function assistantModelName(message: Pick<AssistantMessage, "providerID" | "modelID">, providers: Provider[]) {
  return providers.find((x) => x.id === message.providerID)?.models[message.modelID]?.name || message.modelID
}

export function tokenPercentage(tokens: number, providerID: string, modelID: string, providers: Provider[]) {
  const limit = contextLimit(providerID, modelID, providers)
  if (!limit || tokens <= 0) return null
  return Math.round((tokens / limit) * 100)
}

/** Context usage for the sidebar and prompt, from the last visible assistant message with output. */
export function sessionContextUsage(input: {
  messages: Message[]
  session: Session | undefined
  providers: Provider[]
}) {
  const visible = visibleMessages(input.messages, input.session)
  const last = visible.findLast((m): m is AssistantMessage => m.role === "assistant" && m.tokens.output > 0)
  if (!last) return

  const tokens = assistantMessageTokens(last)
  if (tokens <= 0) return

  return {
    tokens,
    percentage: tokenPercentage(tokens, last.providerID, last.modelID, input.providers),
  }
}

export function formatUsdCost(amount: number) {
  return money.format(amount)
}

export function resolveSessionUsage(input: {
  messages: Message[]
  session: Session | undefined
  providers: Provider[]
}) {
  return {
    cost: sessionRoundCostTotal(input.messages, input.session),
    context: sessionContextUsage(input),
  }
}

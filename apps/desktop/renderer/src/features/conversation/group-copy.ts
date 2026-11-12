import type { AgentAgent, GroupMember } from "@merakcode/sdk"

/**
 * A new group's name and workers taken from an existing group: which agents were in it, nothing of what they did.
 * A worker whose agent is gone is left out and named in skipped.
 */
export function copyGroup(group: { name: string; members: readonly GroupMember[] }, agents: readonly AgentAgent[]) {
  const workers: string[] = []
  const skipped: string[] = []
  for (const member of group.members) {
    if (member.kind !== "agent" || member.agentRole !== "worker") continue
    if (!member.agent || !agents.some((agent) => agent.id === member.agent)) {
      skipped.push(member.name)
      continue
    }
    if (!workers.includes(member.agent)) workers.push(member.agent)
  }
  return { name: group.name, workers, skipped }
}

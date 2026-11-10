import type { EngineEvent, GroupMember } from "../protocol.gen"

/** Applies a group member fact after the caller has checked the stream sequence. */
export function applyToMembers(members: GroupMember[], event: EngineEvent): GroupMember[] {
  if (event.type === "group.created") return structuredClone(event.payload.members ?? [])
  if (event.type === "member.removed") return members.filter((member) => member.id !== event.payload.id)
  if (event.type !== "member.added" && event.type !== "member.updated") return members
  const index = members.findIndex((member) => member.id === event.payload.id)
  if (index < 0) return event.type === "member.added" ? [...members, structuredClone(event.payload)] : members
  return members.map((member, position) => (position === index ? structuredClone(event.payload) : member))
}

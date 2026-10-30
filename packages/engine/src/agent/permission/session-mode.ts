import { Session } from "../session"
import { PermissionMode } from "./mode"

export async function sessionPermissionMode(
  session: Pick<Session.Info, "id" | "parentID" | "permissionMode">,
  fallback?: PermissionMode.Value,
): Promise<PermissionMode.Value> {
  if (!session.parentID) return session.permissionMode ?? fallback ?? PermissionMode.DEFAULT
  const root = await Session.get(await Session.rootID(session.id)).catch(() => undefined)
  return root?.permissionMode ?? PermissionMode.DEFAULT
}

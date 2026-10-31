/**
 * Local engine password, passed in by the launcher via MERAKCODE_SERVER_PASSWORD (desktop client, `merak serve`,
 * tests). Kept in process memory only, never written to the user's directory.
 */
import { Flag } from "../../../infra/flag/flag"

let secret = Flag.MERAKCODE_SERVER_PASSWORD

export function getLocalSecret(): string | undefined {
  return secret
}

export function setLocalSecretForTest(value: string | undefined): void {
  secret = value
}

export * from "./gen/types.gen.js"

import { createClient } from "./gen/client/client.gen.js"
import { type Config } from "./gen/client/types.gen.js"
import { MerakCodeClient } from "./gen/sdk.gen.js"
import { createSdkClient } from "./client-factory.js"
import type { Logger } from "../logger.js"
export * from "./request-deadline.js"
export { type Config as MerakCodeClientConfig, MerakCodeClient }

export function createMerakCodeClient(
  config?: Config & {
    directory?: string
    workspaceFolders?: Array<{ name?: string; path: string }>
    /** Your own run or trace id; the engine writes it into the log line of every request */
    clientRun?: string
    /** Called for every request that fails */
    logger?: Logger
  },
): MerakCodeClient {
  return createSdkClient(config, createClient, MerakCodeClient)
}

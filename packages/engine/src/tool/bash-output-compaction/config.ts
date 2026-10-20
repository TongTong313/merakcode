import { Config } from "../../config/config"
import { EnvVar } from "../../util/env-var"
import type { OutputCompactionConfig, OutputCompactionMode } from "./types"

type OutputCompactionUserConfig =
  | boolean
  | {
      enabled?: boolean
      mode?: OutputCompactionMode
      session_delta?: boolean
      min_bytes?: number
      max_input_bytes?: number
      max_output_bytes?: number
    }

export function getOutputCompactionConfig(config?: OutputCompactionUserConfig): OutputCompactionConfig {
  const object = typeof config === "object" ? config : undefined
  const configuredEnabled = typeof config === "boolean" ? config : object?.enabled
  const disableSession = EnvVar.bool("MERAKCODE_EXPERIMENTAL_BASH_OUTPUT_COMPACTION_DISABLE_SESSION")

  return {
    enabled: EnvVar.bool("MERAKCODE_EXPERIMENTAL_BASH_OUTPUT_COMPACTION") ?? configuredEnabled ?? false,
    mode:
      EnvVar.choice<OutputCompactionMode>(
        "MERAKCODE_EXPERIMENTAL_BASH_OUTPUT_COMPACTION_MODE",
        ["safe", "aggressive"],
        "safe",
      ) ??
      object?.mode ??
      "safe",
    sessionDelta: disableSession === undefined ? (object?.session_delta ?? true) : !disableSession,
    minBytes: EnvVar.int("MERAKCODE_EXPERIMENTAL_BASH_OUTPUT_COMPACTION_MIN_BYTES") ?? object?.min_bytes ?? 500,
    maxInputBytes:
      EnvVar.int("MERAKCODE_EXPERIMENTAL_BASH_OUTPUT_COMPACTION_MAX_INPUT_BYTES") ??
      object?.max_input_bytes ??
      2 * 1024 * 1024,
    maxCompactedBytes:
      EnvVar.int("MERAKCODE_EXPERIMENTAL_BASH_OUTPUT_COMPACTION_MAX_OUTPUT_BYTES") ??
      object?.max_output_bytes ??
      40 * 1024,
  }
}

export async function getConfiguredOutputCompactionConfig(): Promise<OutputCompactionConfig> {
  const config = await Config.get()
  return getOutputCompactionConfig(config.experimental?.bash_output_compaction)
}

import { Config } from "../../config/config"
import { EnvVar } from "../../util/env-var"
import { DEFAULT_MAX_BLOCK_FOLD_BYTES, DEFAULT_MIN_BYTES } from "./types"
import type { LosslessConfig } from "./types"

type LosslessUserConfig =
  | boolean
  | {
      enabled?: boolean
      min_bytes?: number
      max_block_fold_bytes?: number
    }

/**
 * Resolves the lossless compaction config. Unlike the lossy layer it is enabled by default.
 * Precedence: environment variable, then user config, then enabled.
 */
export function getLosslessConfig(config?: LosslessUserConfig): LosslessConfig {
  const object = typeof config === "object" ? config : undefined
  const configuredEnabled = typeof config === "boolean" ? config : object?.enabled

  return {
    enabled: EnvVar.bool("MERAKCODE_LOSSLESS_COMPACTION") ?? configuredEnabled ?? true,
    minBytes: EnvVar.int("MERAKCODE_LOSSLESS_COMPACTION_MIN_BYTES") ?? object?.min_bytes ?? DEFAULT_MIN_BYTES,
    maxBlockFoldBytes:
      EnvVar.int("MERAKCODE_LOSSLESS_COMPACTION_MAX_BLOCK_FOLD_BYTES") ??
      object?.max_block_fold_bytes ??
      DEFAULT_MAX_BLOCK_FOLD_BYTES,
  }
}

export async function getConfiguredLosslessConfig(): Promise<LosslessConfig> {
  const config = await Config.get()
  return getLosslessConfig(config.compaction?.lossless)
}

import { compactGitDiff, compactGitLog, compactGitStatus } from "./filters/git"
import { compactListingOutput } from "./filters/listing"
import { compactRepeatedLogs } from "./filters/logs"
import { compactPackageManagerOutput } from "./filters/package-manager"
import { compactTestOutput } from "./filters/tests"
import type { CompactContext, FilterResult, OutputCompactionConfig, OutputFilter } from "./types"

const FILTERS: OutputFilter[] = [
  compactGitDiff,
  compactGitStatus,
  compactGitLog,
  compactTestOutput,
  compactPackageManagerOutput,
  compactListingOutput,
  compactRepeatedLogs,
]

export function applyOutputFilters(context: CompactContext, config: OutputCompactionConfig): FilterResult | null {
  for (const filter of FILTERS) {
    const result = filter(context, config)
    if (result) return result
  }
  return null
}

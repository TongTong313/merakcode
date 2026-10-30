export type OutputCompactionMode = "safe" | "aggressive"

export type OutputCompactionConfig = {
  enabled: boolean
  mode: OutputCompactionMode
  sessionDelta: boolean
  minBytes: number
  maxInputBytes: number
  maxCompactedBytes: number
}

export type CompactContext = {
  command: string
  cwd: string
  sessionID?: string
  exitCode: number | null
  stdout: string
  persistedOutputPath?: string
  persistedOutputSize?: number
}

export type CompactFileContext = Omit<CompactContext, "stdout"> & {
  outputPath: string
  outputSize: number
}

export type CompactResult = {
  output: string
  filterName: string
  originalBytes: number
  compactedBytes: number
  rawOutputPath?: string
}

export type FilterResult = {
  output: string
  filterName: string
}

export type OutputFilter = (context: CompactContext, config: OutputCompactionConfig) => FilterResult | null

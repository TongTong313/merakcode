/** Explicit start instructions shared by the editor save boundary and the execution admission boundary. */
export function startsSessionPlan(text: string) {
  return /^(?:开始执行|开始实施|执行方案|按(?:这个|当前|最新)?计划(?:执行|实施)|按原计划再做一遍|execute (?:the )?(?:latest saved session )?plan|(?:rerun|repeat) (?:the )?(?:original )?plan|start implementing)[。.!！\s]*$/i.test(
    text.trim(),
  )
}

/** Only an explicit whole instruction resumes paused execution; mentions and partial retries do not. */
export function resumesSessionPlan(text: string) {
  return /^(?:继续执行(?:当前任务|当前计划|原计划)?|恢复执行(?:当前任务|当前计划|原计划)?|(?:resume|continue)(?: (?:the )?(?:current )?(?:task|plan|execution))?)[。.!！\s]*$/i.test(
    text.trim(),
  )
}

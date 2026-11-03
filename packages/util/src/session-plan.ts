/** Explicit start instructions shared by the editor save boundary and the execution admission boundary. */
export function startsSessionPlan(text: string) {
  return /^(?:开始执行|开始实施|执行方案|按(?:这个|当前|最新)?计划(?:执行|实施)|按原计划再做一遍|execute (?:the )?(?:latest saved session )?plan|(?:rerun|repeat) (?:the )?(?:original )?plan|start implementing)[。.!！\s]*$/i.test(
    text.trim(),
  )
}

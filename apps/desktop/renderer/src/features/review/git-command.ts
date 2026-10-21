/** Splits a git command line into arguments. Quoted text stays one argument. */
export function splitGitArgs(input: string) {
  const args: string[] = []
  for (const match of input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) args.push(match[1] ?? match[2] ?? match[3] ?? "")
  return args
}

/**
 * Commands that rewrite history or delete files: reset --hard, clean, push --force (and -f), branch -D.
 * The review bar asks before running these.
 */
export function dangerousGit(args: string[]) {
  const [command, ...rest] = args
  if (!command) return false
  if (command === "reset" && rest.includes("--hard")) return true
  if (command === "clean") return true
  if (command === "push" && rest.some((arg) => arg === "--force" || arg === "-f")) return true
  if (command === "branch" && rest.includes("-D")) return true
  return false
}

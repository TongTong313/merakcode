/**
 * Credential scan run before writing memory files.
 *
 * MemoryRecall injects memory content into the prompts of all future conversations, so a real key copied from a
 * conversation into a memory file spreads much further than a one-off leak.
 *
 * The rule set is small and high-confidence on purpose: missing a secret is preferred over rejecting normal memory
 * writes. Add rules in the same { id, re } shape.
 */
export namespace MemorySecretScan {
  type Rule = { id: string; re: RegExp }

  const RULES: Rule[] = [
    { id: "aws-access-key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
    { id: "anthropic-api-key", re: /\bsk-ant-[a-zA-Z0-9_-]{20,}\b/ },
    { id: "openai-api-key", re: /\bsk-(?:proj-|svcacct-)?[a-zA-Z0-9]{20,}\b/ },
    { id: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/ },
    { id: "google-api-key", re: /\bAIza[\w-]{35}\b/ },
    { id: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
    { id: "private-key-block", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  ]

  /** Ids of the matching rules; never the matched text, so secrets do not end up in logs or error messages */
  export function scan(content: string): string[] {
    return RULES.filter((rule) => rule.re.test(content)).map((rule) => rule.id)
  }
}

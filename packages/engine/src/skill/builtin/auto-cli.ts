/**
 * auto-cli
 */

export const AUTO_CLI_SKILL = {
  name: "auto-cli",
  description:
    "Turn an OpenAPI 3.x spec into a compiled CLI binary using specli, then generate a SKILL.md for the compiled binary",
  content: `# auto-cli

This skill executes a fixed sequence of steps. Follow them in order. Do not skip steps. Do not write any code — the CLI is generated entirely by \`specli compile\`.

## Step 1 — Verify specli is installed

Run:
\`\`\`sh
specli --version
\`\`\`

If the command fails, install it:
\`\`\`sh
npm install -g specli
\`\`\`

Do not proceed until \`specli --version\` succeeds.

## Step 2 — Confirm inputs and validate the spec

You need:
- \`<spec>\`: path or URL to an OpenAPI 3.x spec (YAML or JSON)
- \`<name>\`: desired binary name

If either is missing, ask the user before proceeding.

Validate the spec by running:
\`\`\`sh
specli exec <spec> __schema
\`\`\`

If this command fails, the spec is invalid or not an OpenAPI 3.x document — report the error to the user and do not proceed.

## Step 3 — Compile the CLI

Run:
\`\`\`sh
specli compile <spec> --name <name>
\`\`\`

This produces \`./out/<name>\`. Do not write any CLI code. If compilation fails, fix the error and retry — do not fall back to writing code.

Move the binary to a directory on PATH. Choose based on the current OS:

**macOS / Linux:**
\`\`\`sh
mv ./out/<name> /usr/local/bin/<name> 2>/dev/null || mv ./out/<name> "$HOME/.local/bin/<name>"
which <name>
\`\`\`

**Windows:**
\`\`\`powershell
Move-Item .\\out\\<name>.exe "$Env:USERPROFILE\\AppData\\Local\\Microsoft\\WindowsApps\\<name>.exe"
Get-Command <name>
\`\`\`

Do not proceed until the verification command confirms the binary is on PATH.

## Step 4 — Smoke-test the binary

Run both commands and confirm they succeed:
\`\`\`sh
<name> --help
<name> __schema
\`\`\`

If either fails, the binary is broken — do not proceed to Step 5.

## Step 5 — Collect CLI metadata

Run these commands and capture their output:
\`\`\`sh
<name> __schema
<name> --help
\`\`\`

For each resource listed in \`__schema\`, run:
\`\`\`sh
<name> <resource> --help
\`\`\`

## Step 6 — Write SKILL.md

Using only the output collected in Step 5, write a SKILL.md file at \`.merakcode/skills/<name>/SKILL.md\`.

The file must follow this exact template:

\`\`\`markdown
---
name: "<name>"
description: "<one-line description of what API this CLI wraps>"
---

# <name>

<one sentence: what API this wraps and what it does>

## Requirements

The \`<name>\` binary is already installed and available on PATH.

## Auth

<describe auth scheme extracted from --help / __schema>

\\\`\\\`\\\`sh
<name> login
<name> --bearer-token <token> <resource> <action>
\\\`\\\`\\\`

## Agent usage

Use \`--json\` for machine-readable output:
\\\`\\\`\\\`sh
<name> --json <resource> list
<name> --json <resource> get --id <id>
\\\`\\\`\\\`

Use \`--curl\` to preview a request without sending it:
\\\`\\\`\\\`sh
<name> --curl <resource> <action> --<param> <value>
\\\`\\\`\\\`

## Commands

<for each resource from __schema, one line: \`<resource>\` — what it does>

## Examples

<3–5 realistic examples covering common workflows>

## Full command reference

<exact output of \`<name> __schema\`>
\`\`\`

## Step 7 — Install the skill globally

Copy the generated SKILL.md to the global skills directory so it is available in future sessions.

**macOS / Linux:**
\`\`\`sh
mkdir -p ~/.config/merakcode/skills/<name>
cp .merakcode/skills/<name>/SKILL.md ~/.config/merakcode/skills/<name>/SKILL.md
\`\`\`

**Windows:**
\`\`\`powershell
New-Item -ItemType Directory -Force "$Env:LOCALAPPDATA\\merakcode\\skills\\<name>"
Copy-Item ".merakcode\\skills\\<name>\\SKILL.md" "$Env:LOCALAPPDATA\\merakcode\\skills\\<name>\\SKILL.md"
\`\`\`

Confirm the file exists at the destination before reporting the skill as installed.
`,
}

/**
 * Windows sandbox spike (not shipped). Run from the repo root:
 *   node --import ./script/node/register.mjs packages/sandbox/spike/windows/spike.ts setup     (one UAC prompt)
 *   node --import ./script/node/register.mjs packages/sandbox/spike/windows/spike.ts test
 *   node --import ./script/node/register.mjs packages/sandbox/spike/windows/spike.ts cleanup   (one UAC prompt)
 */
import { execFileSync, spawn } from "node:child_process"
import { randomBytes, randomInt } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { SandboxEnv } from "../../src/env"
import { SandboxProxy } from "../../src/proxy"

const here = import.meta.dirname
const out = path.join(here, "out")
const helper = path.join(out, "helper.exe")
const stateFile = path.join(out, "state.json")
const user = "merakcode-sbx"
const base = path.join(os.tmpdir(), "merak-spike")
const dirs = {
  work: path.join(base, "work"),
  home: path.join(base, "home"),
  tmp: path.join(base, "tmp"),
}
const system = process.env.SystemRoot ?? "C:\\Windows"
const powershell = path.join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
const cmd = path.join(system, "System32", "cmd.exe")
const curl = path.join(system, "System32", "curl.exe")
const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe"

type State = { sid: string; password: string }

function state(): State {
  return JSON.parse(readFileSync(stateFile, "utf8"))
}

/** Windows command-line quoting (CommandLineToArgvW rules) */
function quote(arg: string) {
  if (arg && !/[\s"]/.test(arg)) return arg
  let result = '"'
  for (let i = 0; i < arg.length; i++) {
    let slashes = 0
    while (i < arg.length && arg[i] === "\\") {
      slashes++
      i++
    }
    if (i === arg.length) {
      result += "\\".repeat(slashes * 2)
      break
    }
    if (arg[i] === '"') result += "\\".repeat(slashes * 2 + 1) + '"'
    else result += "\\".repeat(slashes) + arg[i]
  }
  return result + '"'
}

function password() {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!#%*+-=?@^_"]
  const all = sets.join("")
  const chars = [
    ...sets.map((set) => set[randomInt(set.length)]!),
    ...Array.from({ length: 28 }, () => all[randomInt(all.length)]!),
  ]
  return chars.sort(() => randomInt(3) - 1).join("")
}

function elevated(script: string, args: string[]) {
  const list = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args].map(
    (arg) => `'${arg.replaceAll("'", "''")}'`,
  )
  execFileSync(powershell, [
    "-NoProfile",
    "-Command",
    `Start-Process -FilePath '${powershell}' -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList ${list.join(",")}`,
  ])
}

function icacls(...args: string[]) {
  execFileSync("icacls", args, { stdio: "pipe" })
}

async function setup() {
  mkdirSync(out, { recursive: true })
  const secret = password()
  const request = path.join(out, `request-${randomBytes(4).toString("hex")}.json`)
  writeFileSync(request, JSON.stringify({ user, password: secret }))
  icacls(request, "/inheritance:r", "/grant:r", `${os.userInfo().username}:F`)
  console.log("Asking for administrator rights (UAC) to create the sandbox account and firewall rule...")
  elevated(path.join(here, "setup.ps1"), ["-Request", request])
  rmSync(request, { force: true })
  const result = JSON.parse(readFileSync(request + ".result", "utf8")) as { sid?: string; error?: string }
  rmSync(request + ".result", { force: true })
  if (!result.sid) throw new Error(`setup failed: ${result.error}`)
  console.log("account SID", result.sid)
  execFileSync(helper, ["protect", path.join(out, "password.bin")], { input: secret + "\n" })
  writeFileSync(stateFile, JSON.stringify({ sid: result.sid, password: "" } satisfies State))

  rmSync(base, { recursive: true, force: true })
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
  mkdirSync(path.join(dirs.home, ".ssh"))
  writeFileSync(path.join(dirs.home, ".ssh", "id_rsa"), "FAKE PRIVATE KEY\n")
  writeFileSync(path.join(dirs.home, "note.txt"), "readable note\n")
  execFileSync("git", ["init", "--quiet", dirs.work])
  const sid = `*${result.sid}`
  icacls(dirs.work, "/grant", `${sid}:(OI)(CI)M`)
  icacls(dirs.tmp, "/grant", `${sid}:(OI)(CI)M`)
  icacls(dirs.home, "/grant", `${sid}:(OI)(CI)RX`)
  icacls(path.join(dirs.home, ".ssh"), "/deny", `${sid}:(OI)(CI)R`)
  icacls(path.join(dirs.work, ".git", "hooks"), "/deny", `${sid}:(OI)(CI)(WD,AD,WEA,WA,DE,DC)`)
  icacls(path.join(dirs.work, ".git", "config"), "/deny", `${sid}:(WD,AD,WEA,WA,DE)`)
  console.log("setup done")
}

type Result = { code: number | null; stdout: Buffer; stderr: Buffer }

let counter = 0
function sandboxed(file: string, args: string, env: Record<string, string>, cwd = dirs.work) {
  const request = path.join(out, `run-${process.pid}-${counter++}`)
  const fields = [
    user,
    path.join(out, "password.bin"),
    cwd,
    file,
    args,
    ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
  ]
  writeFileSync(request, fields.join("\0"))
  return spawn(helper, ["run", request], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
}

function collect(child: ReturnType<typeof spawn>): Promise<Result> {
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk))
  child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk))
  return new Promise((resolve) =>
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })),
  )
}

function direct(file: string, args: string[], cwd = dirs.work): Promise<Result> {
  return collect(spawn(file, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }))
}

const results: { name: string; ok: boolean; note: string }[] = []
function record(name: string, ok: boolean, note = "") {
  results.push({ name, ok, note })
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${note ? `  -- ${note}` : ""}`)
}
const text = (result: Result) => (result.stdout.toString("utf8") + result.stderr.toString("utf8")).trim().slice(0, 300)

async function test() {
  state()
  const target = http.createServer((_req, res) => res.end("target-ok"))
  await new Promise<void>((resolve) => target.listen(0, "0.0.0.0", resolve))
  const port = (target.address() as { port: number }).port
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find((item) => item && item.family === "IPv4" && !item.internal)?.address
  const proxy = await SandboxProxy.start()
  proxy.register("spike", {
    allow: ["example.com", "registry.npmjs.org", "registry.npmmirror.com", ...(lan ? [lan] : [])],
    deny: ["denied.example"],
    blockPorts: [],
    ask: async () => false,
  })
  const env = SandboxEnv.build({ platform: "win32", proxy: proxy.url("spike"), tmp: dirs.tmp, base: process.env })
  const run = (file: string, args: string, cwd?: string) => collect(sandboxed(file, args, env, cwd))

  // 2: run as the sandbox account and get the output back unchanged
  const who = await run(cmd, '/d /s /c "whoami"')
  record(
    "2a runs as the sandbox account",
    who.code === 0 && who.stdout.toString().toLowerCase().includes(user),
    text(who),
  )
  const node = process.execPath
  const script = "process.stdout.write('\u4f60\u597d\\n');process.stderr.write('\u9519\u8bef\\n');process.exit(7)"
  const utf8 = await run(node, `-e ${quote(script)}`)
  record(
    "2b UTF-8 stdout/stderr and exit code come back unchanged",
    utf8.code === 7 &&
      utf8.stdout.toString("utf8") === "\u4f60\u597d\n" &&
      utf8.stderr.toString("utf8") === "\u9519\u8bef\n",
    `code=${utf8.code} ${text(utf8)}`,
  )
  const plain = await direct(cmd, ["/d", "/s", "/c", "echo \u4f60\u597d"])
  const boxed = await run(cmd, '/d /s /c "echo \u4f60\u597d"')
  record(
    "2c cmd output bytes match a direct run",
    plain.stdout.equals(boxed.stdout),
    `${plain.stdout.toString("hex")} vs ${boxed.stdout.toString("hex")}`,
  )
  const args = ["a b", 'q"x', "c:\\path\\", "\u4e2d\u6587", ""]
  const argv = await run(
    node,
    `-e ${quote("console.log(JSON.stringify(process.argv.slice(1)))")} ${args.map(quote).join(" ")}`,
  )
  record(
    "2d arguments with spaces, quotes, backslashes and Chinese",
    argv.stdout.toString().trim() === JSON.stringify(args),
    text(argv),
  )
  const envCase = await run(cmd, '/d /s /c "set"')
  record(
    "2e environment names keep their case",
    /^Path=/m.test(envCase.stdout.toString()) || /^PATH=/m.test(envCase.stdout.toString()),
    text(envCase).slice(0, 120),
  )

  // 3: network only through the proxy
  const loopback = await run(curl, `-s -m 5 http://127.0.0.1:${port}/`)
  record("3a loopback works", loopback.stdout.toString() === "target-ok", text(loopback))
  if (lan) {
    // Windows treats the machine's own addresses as loopback and the firewall does not filter them
    const own = await run(curl, `-s -m 5 --noproxy * http://${lan}:${port}/`)
    record("3b own LAN address behaves like loopback (known Windows limit)", true, `sandboxed: ${text(own)}`)
  }
  const site = "https://www.baidu.com"
  const internet = await direct(curl, ["-s", "-m", "8", "-o", "NUL", "-w", "%{http_code}", "--noproxy", "*", site])
  if (internet.stdout.toString().startsWith("2") || internet.stdout.toString().startsWith("3")) {
    proxy.register("spike", {
      allow: ["www.baidu.com", "registry.npmmirror.com", "*.npmmirror.com"],
      deny: ["denied.example"],
      blockPorts: [],
      ask: async () => false,
    })
    const blocked = await run(curl, `-s -m 8 -o NUL -w %{http_code} --noproxy * ${site}`)
    const proxied = await run(curl, `-s -m 15 -o NUL -w %{http_code} ${site}`)
    record(
      "3c internet: direct blocked, through the proxy allowed",
      !blocked.stdout.toString().startsWith("2") && proxied.stdout.toString().startsWith("2"),
      `direct=${text(blocked)} proxy=${text(proxied)}`,
    )
  } else record("3c internet", true, `skipped: ${site} is not reachable from this machine (${text(internet)})`)
  const denied = await run(curl, "-s -m 5 http://denied.example/")
  record(
    "3e denied host gets the sandbox message",
    denied.stdout.toString().includes("blocked by MerakCode sandbox"),
    text(denied),
  )

  // 4: files
  const secret = await run(cmd, `/d /s /c "type ${path.join(dirs.home, ".ssh", "id_rsa")}"`)
  record(
    "4a cannot read the denied .ssh folder",
    secret.code !== 0 && !secret.stdout.toString().includes("FAKE"),
    text(secret),
  )
  const note = await run(cmd, `/d /s /c "type ${path.join(dirs.home, "note.txt")}"`)
  record(
    "4b can read an allowed file outside the workspace",
    note.stdout.toString().includes("readable note"),
    text(note),
  )
  const outside = path.join(dirs.home, "outside.txt")
  const write = await run(cmd, `/d /s /c "echo x> ${outside}"`)
  record("4c cannot write outside the allowed folders", !existsSync(outside), `code=${write.code} ${text(write)}`)
  const inside = await run(cmd, '/d /s /c "echo x> inside.txt"')
  record(
    "4d can write in the workspace",
    existsSync(path.join(dirs.work, "inside.txt")),
    `code=${inside.code} ${text(inside)}`,
  )
  const hook = await run(cmd, '/d /s /c "echo evil> .git\\hooks\\pre-commit"')
  record(
    "4e cannot add a git hook",
    !existsSync(path.join(dirs.work, ".git", "hooks", "pre-commit")),
    `code=${hook.code} ${text(hook)}`,
  )
  const config = await run(cmd, '/d /s /c "echo [x]>> .git\\config"')
  record(
    "4f cannot change .git/config",
    !readFileSync(path.join(dirs.work, ".git", "config"), "utf8").includes("[x]"),
    `code=${config.code} ${text(config)}`,
  )
  const tmp = await run(cmd, '/d /s /c "echo t> %TEMP%\\t.txt"')
  record("4g can write the sandbox temp dir", existsSync(path.join(dirs.tmp, "t.txt")), text(tmp))

  // 5: everyday tools
  const tools: [string, string, string, string?][] = [
    ["5a cmd", cmd, '/d /s /c "echo ok"'],
    ["5b PowerShell", powershell, '-NoProfile -NonInteractive -Command "Write-Output ok"'],
    ["5c Git Bash", gitBash, '-c "echo ok && uname -s"'],
    ["5d node -v", node, "-v"],
    [
      "5e npm --version",
      node,
      `${quote(path.join(path.dirname(node), "node_modules", "npm", "bin", "npm-cli.js"))} --version`,
    ],
    ["5f git --version", "C:\\Program Files\\Git\\cmd\\git.exe", "--version"],
    ["5g git status", "C:\\Program Files\\Git\\cmd\\git.exe", "status --short"],
    [
      "5h git commit",
      "C:\\Program Files\\Git\\cmd\\git.exe",
      '-c user.name=spike -c user.email=spike@example.com commit --allow-empty -m "spike"',
    ],
    [
      "5i python --version",
      path.join(os.homedir(), "AppData", "Local", "Programs", "Python", "Python312", "python.exe"),
      "--version",
    ],
  ]
  for (const [name, file, args] of tools) {
    if (!existsSync(file)) {
      record(name, true, `skipped: ${file} not installed`)
      continue
    }
    const result = await run(file, args)
    record(name, result.code === 0, `code=${result.code} ${text(result)}`)
  }
  const registry = "https://registry.npmmirror.com"
  const npm = await collect(
    sandboxed(
      node,
      `${quote(path.join(path.dirname(node), "node_modules", "npm", "bin", "npm-cli.js"))} install is-number --no-audit --no-fund --registry ${registry}`,
      { ...env, npm_config_cache: path.join(dirs.tmp, "npm-cache") },
    ),
  )
  record(
    "5j npm install through the proxy",
    npm.code === 0 && existsSync(path.join(dirs.work, "node_modules", "is-number")),
    `registry=${registry} code=${npm.code} ${text(npm).slice(-200)}`,
  )

  // 6: killing the helper ends the whole tree
  rmSync(path.join(dirs.work, "pid.txt"), { force: true })
  const tree = sandboxed(
    powershell,
    `-NoProfile -Command "$p = Start-Process -FilePath ping.exe -ArgumentList '-n','120','127.0.0.1' -PassThru -NoNewWindow; Set-Content -Path '${path.join(dirs.work, "pid.txt")}' -Value $p.Id; Start-Sleep 120"`,
    env,
  )
  tree.stdout!.resume()
  tree.stderr!.resume()
  const pidFile = path.join(dirs.work, "pid.txt")
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await sleep(200)
  const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : 0
  const alive = (id: number) => {
    try {
      process.kill(id, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM"
    }
  }
  const before = pid > 0 && alive(pid)
  tree.kill()
  await sleep(2000)
  record(
    "6 killing the helper ends the grandchild",
    before && !alive(pid),
    `pid=${pid} aliveBefore=${before} aliveAfter=${pid > 0 && alive(pid)}`,
  )

  await proxy.close()
  target.close()
  writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2))
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`)
}

async function cleanup() {
  const sid = existsSync(stateFile) ? state().sid : undefined
  // Before the account is deleted: afterwards icacls cannot map the SID any more (error 1332)
  if (sid)
    for (const dir of Object.values(dirs)) if (existsSync(dir)) icacls(dir, "/remove", `*${sid}`, "/t", "/c", "/q")
  const result = path.join(out, "cleanup.result.json")
  console.log("Asking for administrator rights (UAC) to remove the sandbox account and firewall rule...")
  elevated(path.join(here, "cleanup.ps1"), ["-User", user, "-Result", result])
  if (existsSync(result)) console.log(readFileSync(result, "utf8"))
  rmSync(base, { recursive: true, force: true, maxRetries: 5 })
  for (const file of ["password.bin", "state.json", "cleanup.result.json"])
    rmSync(path.join(out, file), { force: true })
  console.log("cleanup done")
}

/** Runs one command as the sandbox account with the sandbox environment, for debugging: exec <file> <raw args> */
async function exec(file: string, args: string) {
  const proxy = await SandboxProxy.start()
  proxy.register("spike", { allow: ["*"], deny: [], blockPorts: [], ask: async () => true })
  const env = SandboxEnv.build({ platform: "win32", proxy: proxy.url("spike"), tmp: dirs.tmp, base: process.env })
  const result = await collect(sandboxed(file, args, env))
  console.log(`exit ${result.code}\n--- stdout\n${result.stdout.toString()}\n--- stderr\n${result.stderr.toString()}`)
  await proxy.close()
}

const step = process.argv[2]
if (step === "setup") await setup()
else if (step === "test") await test()
else if (step === "cleanup") await cleanup()
else if (step === "exec") await exec(process.argv[3]!, process.argv[4] ?? "")
else console.log("usage: spike.ts setup|test|cleanup|exec <file> <args>")

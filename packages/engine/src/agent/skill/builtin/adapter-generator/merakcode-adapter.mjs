// MerakCode adapter library (member protocol). Generated from @merakcode/sdk/adapter; do not edit.
import { createRequire as __merakcodeRequire } from "node:module"
const require = __merakcodeRequire(import.meta.url)
var __create = Object.create
var __defProp = Object.defineProperty
var __getOwnPropDesc = Object.getOwnPropertyDescriptor
var __getOwnPropNames = Object.getOwnPropertyNames
var __getProtoOf = Object.getPrototypeOf
var __hasOwnProp = Object.prototype.hasOwnProperty
var __require = /* @__PURE__ */ ((x) =>
  typeof require !== "undefined"
    ? require
    : typeof Proxy !== "undefined"
      ? new Proxy(x, {
          get: (a, b) => (typeof require !== "undefined" ? require : a)[b],
        })
      : x)(function (x) {
  if (typeof require !== "undefined") return require.apply(this, arguments)
  throw Error('Dynamic require of "' + x + '" is not supported')
})
var __commonJS = (cb, mod) =>
  function __require2() {
    try {
      return (mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports)
    } catch (e) {
      throw ((mod = 0), e)
    }
  }
var __copyProps = (to, from, except, desc) => {
  if ((from && typeof from === "object") || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, {
          get: () => from[key],
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable,
        })
  }
  return to
}
var __toESM = (mod, isNodeMode, target) => (
  (target = mod != null ? __create(__getProtoOf(mod)) : {}),
  __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod,
  )
)

// node_modules/.pnpm/isexe@2.0.0/node_modules/isexe/windows.js
var require_windows = __commonJS({
  "node_modules/.pnpm/isexe@2.0.0/node_modules/isexe/windows.js"(exports, module) {
    module.exports = isexe
    isexe.sync = sync
    var fs = __require("fs")
    function checkPathExt(path, options) {
      var pathext = options.pathExt !== void 0 ? options.pathExt : process.env.PATHEXT
      if (!pathext) {
        return true
      }
      pathext = pathext.split(";")
      if (pathext.indexOf("") !== -1) {
        return true
      }
      for (var i = 0; i < pathext.length; i++) {
        var p = pathext[i].toLowerCase()
        if (p && path.substr(-p.length).toLowerCase() === p) {
          return true
        }
      }
      return false
    }
    function checkStat(stat, path, options) {
      if (!stat.isSymbolicLink() && !stat.isFile()) {
        return false
      }
      return checkPathExt(path, options)
    }
    function isexe(path, options, cb) {
      fs.stat(path, function (er, stat) {
        cb(er, er ? false : checkStat(stat, path, options))
      })
    }
    function sync(path, options) {
      return checkStat(fs.statSync(path), path, options)
    }
  },
})

// node_modules/.pnpm/isexe@2.0.0/node_modules/isexe/mode.js
var require_mode = __commonJS({
  "node_modules/.pnpm/isexe@2.0.0/node_modules/isexe/mode.js"(exports, module) {
    module.exports = isexe
    isexe.sync = sync
    var fs = __require("fs")
    function isexe(path, options, cb) {
      fs.stat(path, function (er, stat) {
        cb(er, er ? false : checkStat(stat, options))
      })
    }
    function sync(path, options) {
      return checkStat(fs.statSync(path), options)
    }
    function checkStat(stat, options) {
      return stat.isFile() && checkMode(stat, options)
    }
    function checkMode(stat, options) {
      var mod = stat.mode
      var uid = stat.uid
      var gid = stat.gid
      var myUid = options.uid !== void 0 ? options.uid : process.getuid && process.getuid()
      var myGid = options.gid !== void 0 ? options.gid : process.getgid && process.getgid()
      var u = parseInt("100", 8)
      var g = parseInt("010", 8)
      var o = parseInt("001", 8)
      var ug = u | g
      var ret = mod & o || (mod & g && gid === myGid) || (mod & u && uid === myUid) || (mod & ug && myUid === 0)
      return ret
    }
  },
})

// node_modules/.pnpm/isexe@2.0.0/node_modules/isexe/index.js
var require_isexe = __commonJS({
  "node_modules/.pnpm/isexe@2.0.0/node_modules/isexe/index.js"(exports, module) {
    var fs = __require("fs")
    var core
    if (process.platform === "win32" || global.TESTING_WINDOWS) {
      core = require_windows()
    } else {
      core = require_mode()
    }
    module.exports = isexe
    isexe.sync = sync
    function isexe(path, options, cb) {
      if (typeof options === "function") {
        cb = options
        options = {}
      }
      if (!cb) {
        if (typeof Promise !== "function") {
          throw new TypeError("callback not provided")
        }
        return new Promise(function (resolve, reject) {
          isexe(path, options || {}, function (er, is) {
            if (er) {
              reject(er)
            } else {
              resolve(is)
            }
          })
        })
      }
      core(path, options || {}, function (er, is) {
        if (er) {
          if (er.code === "EACCES" || (options && options.ignoreErrors)) {
            er = null
            is = false
          }
        }
        cb(er, is)
      })
    }
    function sync(path, options) {
      try {
        return core.sync(path, options || {})
      } catch (er) {
        if ((options && options.ignoreErrors) || er.code === "EACCES") {
          return false
        } else {
          throw er
        }
      }
    }
  },
})

// node_modules/.pnpm/which@2.0.2/node_modules/which/which.js
var require_which = __commonJS({
  "node_modules/.pnpm/which@2.0.2/node_modules/which/which.js"(exports, module) {
    var isWindows = process.platform === "win32" || process.env.OSTYPE === "cygwin" || process.env.OSTYPE === "msys"
    var path = __require("path")
    var COLON = isWindows ? ";" : ":"
    var isexe = require_isexe()
    var getNotFoundError = (cmd) => Object.assign(new Error(`not found: ${cmd}`), { code: "ENOENT" })
    var getPathInfo = (cmd, opt) => {
      const colon = opt.colon || COLON
      const pathEnv =
        cmd.match(/\//) || (isWindows && cmd.match(/\\/))
          ? [""]
          : [
              // windows always checks the cwd first
              ...(isWindows ? [process.cwd()] : []),
              ...(opt.path || process.env.PATH /* istanbul ignore next: very unusual */ || "").split(colon),
            ]
      const pathExtExe = isWindows ? opt.pathExt || process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM" : ""
      const pathExt = isWindows ? pathExtExe.split(colon) : [""]
      if (isWindows) {
        if (cmd.indexOf(".") !== -1 && pathExt[0] !== "") pathExt.unshift("")
      }
      return {
        pathEnv,
        pathExt,
        pathExtExe,
      }
    }
    var which = (cmd, opt, cb) => {
      if (typeof opt === "function") {
        cb = opt
        opt = {}
      }
      if (!opt) opt = {}
      const { pathEnv, pathExt, pathExtExe } = getPathInfo(cmd, opt)
      const found = []
      const step = (i) =>
        new Promise((resolve, reject) => {
          if (i === pathEnv.length) return opt.all && found.length ? resolve(found) : reject(getNotFoundError(cmd))
          const ppRaw = pathEnv[i]
          const pathPart = /^".*"$/.test(ppRaw) ? ppRaw.slice(1, -1) : ppRaw
          const pCmd = path.join(pathPart, cmd)
          const p = !pathPart && /^\.[\\\/]/.test(cmd) ? cmd.slice(0, 2) + pCmd : pCmd
          resolve(subStep(p, i, 0))
        })
      const subStep = (p, i, ii) =>
        new Promise((resolve, reject) => {
          if (ii === pathExt.length) return resolve(step(i + 1))
          const ext = pathExt[ii]
          isexe(p + ext, { pathExt: pathExtExe }, (er, is) => {
            if (!er && is) {
              if (opt.all) found.push(p + ext)
              else return resolve(p + ext)
            }
            return resolve(subStep(p, i, ii + 1))
          })
        })
      return cb ? step(0).then((res) => cb(null, res), cb) : step(0)
    }
    var whichSync = (cmd, opt) => {
      opt = opt || {}
      const { pathEnv, pathExt, pathExtExe } = getPathInfo(cmd, opt)
      const found = []
      for (let i = 0; i < pathEnv.length; i++) {
        const ppRaw = pathEnv[i]
        const pathPart = /^".*"$/.test(ppRaw) ? ppRaw.slice(1, -1) : ppRaw
        const pCmd = path.join(pathPart, cmd)
        const p = !pathPart && /^\.[\\\/]/.test(cmd) ? cmd.slice(0, 2) + pCmd : pCmd
        for (let j = 0; j < pathExt.length; j++) {
          const cur = p + pathExt[j]
          try {
            const is = isexe.sync(cur, { pathExt: pathExtExe })
            if (is) {
              if (opt.all) found.push(cur)
              else return cur
            }
          } catch (ex) {}
        }
      }
      if (opt.all && found.length) return found
      if (opt.nothrow) return null
      throw getNotFoundError(cmd)
    }
    module.exports = which
    which.sync = whichSync
  },
})

// node_modules/.pnpm/path-key@3.1.1/node_modules/path-key/index.js
var require_path_key = __commonJS({
  "node_modules/.pnpm/path-key@3.1.1/node_modules/path-key/index.js"(exports, module) {
    "use strict"
    var pathKey = (options = {}) => {
      const environment = options.env || process.env
      const platform = options.platform || process.platform
      if (platform !== "win32") {
        return "PATH"
      }
      return (
        Object.keys(environment)
          .reverse()
          .find((key) => key.toUpperCase() === "PATH") || "Path"
      )
    }
    module.exports = pathKey
    module.exports.default = pathKey
  },
})

// node_modules/.pnpm/cross-spawn@7.0.6/node_modules/cross-spawn/lib/util/resolveCommand.js
var require_resolveCommand = __commonJS({
  "node_modules/.pnpm/cross-spawn@7.0.6/node_modules/cross-spawn/lib/util/resolveCommand.js"(exports, module) {
    "use strict"
    var path = __require("path")
    var which = require_which()
    var getPathKey = require_path_key()
    function resolveCommandAttempt(parsed, withoutPathExt) {
      const env = parsed.options.env || process.env
      const cwd = process.cwd()
      const hasCustomCwd = parsed.options.cwd != null
      const shouldSwitchCwd = hasCustomCwd && process.chdir !== void 0 && !process.chdir.disabled
      if (shouldSwitchCwd) {
        try {
          process.chdir(parsed.options.cwd)
        } catch (err) {}
      }
      let resolved
      try {
        resolved = which.sync(parsed.command, {
          path: env[getPathKey({ env })],
          pathExt: withoutPathExt ? path.delimiter : void 0,
        })
      } catch (e) {
      } finally {
        if (shouldSwitchCwd) {
          process.chdir(cwd)
        }
      }
      if (resolved) {
        resolved = path.resolve(hasCustomCwd ? parsed.options.cwd : "", resolved)
      }
      return resolved
    }
    function resolveCommand(parsed) {
      return resolveCommandAttempt(parsed) || resolveCommandAttempt(parsed, true)
    }
    module.exports = resolveCommand
  },
})

// node_modules/.pnpm/cross-spawn@7.0.6/node_modules/cross-spawn/lib/util/escape.js
var require_escape = __commonJS({
  "node_modules/.pnpm/cross-spawn@7.0.6/node_modules/cross-spawn/lib/util/escape.js"(exports, module) {
    "use strict"
    var metaCharsRegExp = /([()\][%!^"`<>&|;, *?])/g
    function escapeCommand(arg) {
      arg = arg.replace(metaCharsRegExp, "^$1")
      return arg
    }
    function escapeArgument(arg, doubleEscapeMetaChars) {
      arg = `${arg}`
      arg = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
      arg = arg.replace(/(?=(\\+?)?)\1$/, "$1$1")
      arg = `"${arg}"`
      arg = arg.replace(metaCharsRegExp, "^$1")
      if (doubleEscapeMetaChars) {
        arg = arg.replace(metaCharsRegExp, "^$1")
      }
      return arg
    }
    module.exports.command = escapeCommand
    module.exports.argument = escapeArgument
  },
})

// node_modules/.pnpm/shebang-regex@3.0.0/node_modules/shebang-regex/index.js
var require_shebang_regex = __commonJS({
  "node_modules/.pnpm/shebang-regex@3.0.0/node_modules/shebang-regex/index.js"(exports, module) {
    "use strict"
    module.exports = /^#!(.*)/
  },
})

// node_modules/.pnpm/shebang-command@2.0.0/node_modules/shebang-command/index.js
var require_shebang_command = __commonJS({
  "node_modules/.pnpm/shebang-command@2.0.0/node_modules/shebang-command/index.js"(exports, module) {
    "use strict"
    var shebangRegex = require_shebang_regex()
    module.exports = (string = "") => {
      const match = string.match(shebangRegex)
      if (!match) {
        return null
      }
      const [path, argument] = match[0].replace(/#! ?/, "").split(" ")
      const binary = path.split("/").pop()
      if (binary === "env") {
        return argument
      }
      return argument ? `${binary} ${argument}` : binary
    }
  },
})

// node_modules/.pnpm/cross-spawn@7.0.6/node_modules/cross-spawn/lib/util/readShebang.js
var require_readShebang = __commonJS({
  "node_modules/.pnpm/cross-spawn@7.0.6/node_modules/cross-spawn/lib/util/readShebang.js"(exports, module) {
    "use strict"
    var fs = __require("fs")
    var shebangCommand = require_shebang_command()
    function readShebang(command) {
      const size = 150
      const buffer = Buffer.alloc(size)
      let fd
      try {
        fd = fs.openSync(command, "r")
        fs.readSync(fd, buffer, 0, size, 0)
        fs.closeSync(fd)
      } catch (e) {}
      return shebangCommand(buffer.toString())
    }
    module.exports = readShebang
  },
})

// node_modules/.pnpm/cross-spawn@7.0.6/node_modules/cross-spawn/lib/parse.js
var require_parse = __commonJS({
  "node_modules/.pnpm/cross-spawn@7.0.6/node_modules/cross-spawn/lib/parse.js"(exports, module) {
    "use strict"
    var path = __require("path")
    var resolveCommand = require_resolveCommand()
    var escape = require_escape()
    var readShebang = require_readShebang()
    var isWin = process.platform === "win32"
    var isExecutableRegExp = /\.(?:com|exe)$/i
    var isCmdShimRegExp = /node_modules[\\/].bin[\\/][^\\/]+\.cmd$/i
    function detectShebang(parsed) {
      parsed.file = resolveCommand(parsed)
      const shebang = parsed.file && readShebang(parsed.file)
      if (shebang) {
        parsed.args.unshift(parsed.file)
        parsed.command = shebang
        return resolveCommand(parsed)
      }
      return parsed.file
    }
    function parseNonShell(parsed) {
      if (!isWin) {
        return parsed
      }
      const commandFile = detectShebang(parsed)
      const needsShell = !isExecutableRegExp.test(commandFile)
      if (parsed.options.forceShell || needsShell) {
        const needsDoubleEscapeMetaChars = isCmdShimRegExp.test(commandFile)
        parsed.command = path.normalize(parsed.command)
        parsed.command = escape.command(parsed.command)
        parsed.args = parsed.args.map((arg) => escape.argument(arg, needsDoubleEscapeMetaChars))
        const shellCommand = [parsed.command].concat(parsed.args).join(" ")
        parsed.args = ["/d", "/s", "/c", `"${shellCommand}"`]
        parsed.command = process.env.comspec || "cmd.exe"
        parsed.options.windowsVerbatimArguments = true
      }
      return parsed
    }
    function parse2(command, args, options) {
      if (args && !Array.isArray(args)) {
        options = args
        args = null
      }
      args = args ? args.slice(0) : []
      options = Object.assign({}, options)
      const parsed = {
        command,
        args,
        options,
        file: void 0,
        original: {
          command,
          args,
        },
      }
      return options.shell ? parsed : parseNonShell(parsed)
    }
    module.exports = parse2
  },
})

// node_modules/.pnpm/cross-spawn@7.0.6/node_modules/cross-spawn/lib/enoent.js
var require_enoent = __commonJS({
  "node_modules/.pnpm/cross-spawn@7.0.6/node_modules/cross-spawn/lib/enoent.js"(exports, module) {
    "use strict"
    var isWin = process.platform === "win32"
    function notFoundError(original, syscall) {
      return Object.assign(new Error(`${syscall} ${original.command} ENOENT`), {
        code: "ENOENT",
        errno: "ENOENT",
        syscall: `${syscall} ${original.command}`,
        path: original.command,
        spawnargs: original.args,
      })
    }
    function hookChildProcess(cp, parsed) {
      if (!isWin) {
        return
      }
      const originalEmit = cp.emit
      cp.emit = function (name, arg1) {
        if (name === "exit") {
          const err = verifyENOENT(arg1, parsed)
          if (err) {
            return originalEmit.call(cp, "error", err)
          }
        }
        return originalEmit.apply(cp, arguments)
      }
    }
    function verifyENOENT(status, parsed) {
      if (isWin && status === 1 && !parsed.file) {
        return notFoundError(parsed.original, "spawn")
      }
      return null
    }
    function verifyENOENTSync(status, parsed) {
      if (isWin && status === 1 && !parsed.file) {
        return notFoundError(parsed.original, "spawnSync")
      }
      return null
    }
    module.exports = {
      hookChildProcess,
      verifyENOENT,
      verifyENOENTSync,
      notFoundError,
    }
  },
})

// node_modules/.pnpm/cross-spawn@7.0.6/node_modules/cross-spawn/index.js
var require_cross_spawn = __commonJS({
  "node_modules/.pnpm/cross-spawn@7.0.6/node_modules/cross-spawn/index.js"(exports, module) {
    "use strict"
    var cp = __require("child_process")
    var parse2 = require_parse()
    var enoent = require_enoent()
    function spawn2(command, args, options) {
      const parsed = parse2(command, args, options)
      const spawned = cp.spawn(parsed.command, parsed.args, parsed.options)
      enoent.hookChildProcess(spawned, parsed)
      return spawned
    }
    function spawnSync(command, args, options) {
      const parsed = parse2(command, args, options)
      const result = cp.spawnSync(parsed.command, parsed.args, parsed.options)
      result.error = result.error || enoent.verifyENOENTSync(result.status, parsed)
      return result
    }
    module.exports = spawn2
    module.exports.spawn = spawn2
    module.exports.sync = spawnSync
    module.exports._parse = parse2
    module.exports._enoent = enoent
  },
})

// packages/sdk/js/src/adapter/index.ts
var import_cross_spawn = __toESM(require_cross_spawn(), 1)
import { spawn as nodeSpawn } from "node:child_process"
import readline from "node:readline"
var spawn = import_cross_spawn.default
var STOP_GRACE = 3e3
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === void 0) return
  const exited = new Promise((resolve) => child.once("exit", () => resolve(true)))
  if (child.stdin && !child.stdin.writableEnded) {
    child.stdin.end()
    const late2 = new Promise((resolve) => setTimeout(() => resolve(false), STOP_GRACE).unref())
    if (await Promise.race([exited, late2])) return
  }
  if (process.platform === "win32") {
    const kill = nodeSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
    await new Promise((resolve) => {
      kill.once("exit", resolve)
      kill.once("error", resolve)
    })
    return
  }
  for (const pid of [child.pid, ...(await descendants(child.pid))])
    try {
      process.kill(pid, "SIGTERM")
    } catch {}
  const late = new Promise((resolve) => setTimeout(() => resolve(false), STOP_GRACE).unref())
  await Promise.race([exited, late])
}
async function descendants(pid) {
  const listing = await new Promise((resolve) => {
    const ps = nodeSpawn("ps", ["-A", "-o", "pid=", "-o", "ppid="], { stdio: ["ignore", "pipe", "ignore"] })
    let text = ""
    ps.stdout.on("data", (chunk) => (text += chunk))
    ps.once("close", () => resolve(text))
    ps.once("error", () => resolve(""))
  })
  const children = /* @__PURE__ */ new Map()
  for (const line of listing.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number)
    if (child && parent) children.set(parent, [...(children.get(parent) ?? []), child])
  }
  const found = []
  const visit = (parent) => {
    for (const child of children.get(parent) ?? []) {
      found.push(child)
      visit(child)
    }
  }
  visit(pid)
  return found
}
var VERSION_TIMEOUT = 5e3
async function version(command) {
  const child = spawn(command, ["--version"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => (stdout += chunk))
  child.stderr.on("data", (chunk) => (stderr += chunk))
  const ended = new Promise((resolve) => {
    child.once("error", () => resolve("missing"))
    child.once("close", (code2) => resolve(code2 ?? -1))
  })
  let timer
  const late = new Promise((resolve) => (timer = setTimeout(() => resolve("late"), VERSION_TIMEOUT)))
  const code = await Promise.race([ended, late])
  clearTimeout(timer)
  if (code === "missing") return { unavailable: `${command} is not installed` }
  if (code === "late") {
    await stop(child)
    return { unavailable: `${command} --version did not answer within ${VERSION_TIMEOUT / 1e3}s` }
  }
  const first = (text) => text.trim().split(/\r?\n/)[0]
  if (code !== 0) return { unavailable: first(stderr || stdout) || `exit code ${code}` }
  return { version: first(stdout) }
}
var PROTOCOL = 1
var GONE_GRACE = 5e3
var ConnectionClosed = class extends Error {
  constructor() {
    super("The connection closed")
  }
}
function connect(options) {
  let next = 1
  const waiting = /* @__PURE__ */ new Map()
  const write = (message) => options.send(JSON.stringify({ jsonrpc: "2.0", ...message }))
  const answer = async (message) => {
    const handler = options.handlers[message.method]
    if (!handler) {
      if (message.id !== void 0)
        write({ id: message.id, error: { code: -32601, message: `Unknown method ${message.method}` } })
      return
    }
    try {
      const result = await handler(message.params)
      if (message.id !== void 0) write({ id: message.id, result: result ?? null })
    } catch (error) {
      if (message.id !== void 0)
        write({
          id: message.id,
          error: { code: -32e3, message: error instanceof Error ? error.message : String(error) },
        })
    }
  }
  const closed = (async () => {
    for await (const line of options.lines) {
      if (!line.trim()) continue
      const message = parse(line)
      if (!message) {
        options.noise?.(line)
        continue
      }
      if (typeof message.method === "string") {
        void answer(message)
        continue
      }
      const call = message.id === void 0 ? void 0 : waiting.get(message.id)
      if (!call) continue
      waiting.delete(message.id)
      if (message.error) call.reject(new Error(message.error.message))
      else call.resolve(message.result)
    }
    for (const call of waiting.values()) call.reject(new ConnectionClosed())
    waiting.clear()
  })()
  return {
    request(method, params) {
      const id = next++
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject })
        write({ id, method, params })
      })
    },
    notify(method, params) {
      write({ method, params })
    },
    closed,
  }
}
function parse(line) {
  try {
    const value = JSON.parse(line)
    return value && typeof value === "object" && !Array.isArray(value) ? value : void 0
  } catch {
    return void 0
  }
}
function adapter(definition) {
  console.log = console.info = (...items) => console.error(...items)
  const stop2 = new AbortController()
  let product = { id: "", title: "" }
  const rpc = connect({
    lines: readline.createInterface({ input: process.stdin, crlfDelay: Infinity }),
    send: (line) => process.stdout.write(line + "\n"),
    handlers: {
      initialize: async (params) => {
        product = params.product
        return { protocol: PROTOCOL, ...(await definition.inspect(product)) }
      },
      "model/list": () => {
        if (!definition.models) throw new Error("This adapter does not support model discovery")
        return definition.models(product, stop2.signal)
      },
      "task/run": (task) => definition.run({ ...task, product, signal: stop2.signal }, host),
      "task/cancel": () => stop2.abort(),
    },
  })
  const host = {
    sessionStarted: (input) => rpc.request("session.started", input),
    textDelta: (input) => rpc.notify("text.delta", input),
    step: (step) => rpc.notify("step", step),
    permission: (request) => rpc.request("permission/request", { request }),
    question: async (questions) => (await rpc.request("question/ask", { questions })).answers,
  }
  void rpc.closed.then(() => {
    stop2.abort()
    setTimeout(() => process.exit(0), GONE_GRACE).unref()
  })
  process.on("unhandledRejection", (error) => {
    if (error instanceof ConnectionClosed) return
    throw error
  })
}
async function tryAdapter(input) {
  const print = input.print ?? ((line) => console.log(line))
  const { spawn: spawn2 } = await import("node:child_process")
  const [command, ...args] = input.launch
  if (!command) throw new Error("No adapter command")
  const child = spawn2(command, args, { stdio: ["pipe", "pipe", "inherit"] })
  const rpc = connect({
    lines: readline.createInterface({ input: child.stdout, crlfDelay: Infinity }),
    send: (line) => child.stdin.write(line + "\n"),
    handlers: {
      step: (step) => print(`step ${step.tool}${step.detail ? " " + step.detail : ""}`),
      "session.started": (input2) => print(`session ${input2.sessionId}`),
      "text.delta": (input2) => print(`text ${input2.delta}`),
      "permission/request": (params) => {
        print(`permission ${JSON.stringify(params.request)}`)
        return { allow: true }
      },
      "question/ask": (params) => {
        for (const question of params.questions) print(`question ${question.question}`)
        return { answers: params.questions.map((question) => (question.options[0] ? [question.options[0].label] : [])) }
      },
    },
    noise: (line) => print(`not protocol: ${line}`),
  })
  try {
    const info = await rpc.request("initialize", {
      protocol: PROTOCOL,
      product: { id: "test", title: "test" },
    })
    print(`adapter ${info.name}${info.version ? " " + info.version : ""}${info.path ? " at " + info.path : ""}`)
    if (info.unavailable) print(`unavailable: ${info.unavailable}`)
    if (input.prompt === void 0 || info.unavailable) return info
    const result = await rpc.request("task/run", {
      prompt: input.prompt,
      cwd: process.cwd(),
      mode: input.mode ?? "ask",
    })
    print(`result ${result.text}`)
    if (result.sessionId) print(`session ${result.sessionId}`)
    return result
  } finally {
    child.stdin.end()
  }
}
async function cli(argv) {
  const [mode, separator, ...rest] = argv
  if ((mode !== "check" && mode !== "test") || separator !== "--" || rest.length === 0) {
    console.error(
      'Usage: node merakcode-adapter.mjs check -- <adapter command>\n       node merakcode-adapter.mjs test -- <adapter command> "<task>"',
    )
    process.exitCode = 2
    return
  }
  const launch = mode === "test" ? rest.slice(0, -1) : rest
  const prompt = mode === "test" ? rest.at(-1) : void 0
  await tryAdapter({ launch, prompt }).catch((error) => {
    console.error(`failed: ${error.message}`)
    process.exitCode = 1
  })
}
export { ConnectionClosed, PROTOCOL, adapter, cli, connect, spawn, stop, version }
import { fileURLToPath as __merakcodeFile } from "node:url"
if (process.argv[1] && __merakcodeFile(import.meta.url) === (await import("node:fs")).realpathSync(process.argv[1]))
  await cli(process.argv.slice(2))

# 安全

[English](#security)

## 报告漏洞

发现安全问题请不要公开提 issue。到仓库的 [Security 页面](https://github.com/TongTong313/merakcode/security/advisories/new) 点 "Report a vulnerability" 私下提交；用不了的话发邮件到 tongtong950313@gmail.com。

请写上：哪个版本、什么系统、怎么复现、可能造成什么后果。我们会在一周内回复，修好并发布新版本之后再公开细节，并在说明里感谢你（不想署名可以说一声）。

只有最新发布的版本会收到安全修复。

## MerakCode 怎么保护你的电脑

智能体会在你的电脑上读文件、改文件、跑命令。我们靠两道关来管住它：

1. **权限审批**：每个操作先按权限模式（只读、询问、自动）和你的规则判断，是直接做、先问你，还是不做。能从命令文本认出来的删系统、格式化磁盘的命令（比如 `rm -rf /`、`mkfs`），默认在任何模式下都不执行，只有你在配置里明确放行才会跑。
2. **系统沙箱**：智能体通过 `bash` 工具跑的命令，放进操作系统层面的沙箱里执行。就算你批准了一条有问题的命令，它能做的事也有限。

命令的权限审批是按命令文本判断的。`env`、`sudo`、`nice`、`timeout`、`xargs` 这类包装命令按里面那条命令判断，`sh -c "…"`、`eval` 里的命令也会拆开看，`git -C 目录 push` 这类写法也认得出；但脚本文件里的命令、变量拼出来的命令看不到。所以审批不是安全边界，真正限制破坏范围的是沙箱。

沙箱是我们自己写的，只用操作系统自带的能力，没有用第三方沙箱组件。

### 沙箱管什么

- **读**：读不到放密钥的目录：`~/.ssh`、`~/.aws`、`~/.azure`、`~/.kube`、`~/.gnupg`、`~/.docker`、`~/.config/gcloud`、`~/.config/gh`。可以在配置 `sandbox.read.deny` 里加更多（支持 `~/` 写法），但内置的这几个去不掉。其他文件照常能读，包括 `.env`、`~/.npmrc`、`~/.git-credentials`，以及 MerakCode 保存模型服务密钥的 `~/.merakcode/data/auth.json`：这些只靠权限审批，命令的参数写到它们时会先问你。
- **写**：只能写工作区、系统的临时目录（Linux 上是所有用户共用的 `/tmp`，Windows 上还包括你的 `%TEMP%`）、包管理器和应用的缓存（`~/.npm`、`~/.cache`、macOS 的 `~/Library/Caches` 等）、你在审批时同意的目录，以及配置 `sandbox.write.allow` 里的目录（这里不支持 `~/` 写法）。
- **受保护的文件**：工作区里的 `.git/hooks`、`.git/config` 和 MerakCode 的项目配置文件（`merakcode.json`、`merakcode.jsonc`，以及 `.merakcode/` 里的这两个文件）命令改不了，防止命令装一个钩子等你下次提交时执行，或者放宽自己的权限规则。能直接拦的系统直接拦；拦不住的（Linux，以及 Windows 上原本不存在的文件），在命令结束后还原，并告诉模型。只保护这几个位置：`core.hooksPath` 指向的其他目录（比如 husky 的 `.husky/`）、子模块的钩子、把整个 `.git` 换掉，都挡不住。
- **联网**：命令的网络请求要经过引擎内置的代理。npm、PyPI、GitHub 等常用的下载地址直接放行，其他网站先问你。
- **引擎自己的接口**：命令拿不到引擎的口令，调不了引擎的接口，也就没法替自己批准审批请求。在 macOS 和 Linux（内核 6.7 以上）上，命令连引擎的端口都连不上。

### 各系统的实现和限制

| 系统    | 实现                                                                                      | 需要做什么                                                                                                        |
| ------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Windows | 一个隐藏的本地账户 `merakcode-sbx`，用 NTFS 权限限制读写，用防火墙规则拦截它的出站连接    | 在对话栏的沙箱开关里初始化一次（「设置 → 权限与安全」里也能，或者运行 `merak sandbox setup`），同意一次管理员确认 |
| Linux   | Landlock（内核 5.13 以上且开启了 Landlock，需要 glibc），通过 `node:ffi` 直接调用系统调用 | 不用设置                                                                                                          |
| macOS   | 系统自带的 Seatbelt（`sandbox-exec`）                                                     | 不用设置                                                                                                          |

已知的限制（其中一部分 `merak sandbox status` 也会列出来）：

- **Windows**：防火墙管不到本机回环地址，所以命令还能直接连这台电脑上的其他服务（引擎本身有口令保护）。防火墙关着或者被别的防火墙接管时，网络限制不生效。沙箱账户是一个普通用户：系统里本来就允许所有用户写的文件夹，它也能写。给沙箱账户的写权限会一直累加，用过的工作区、审批时同意过的目录，在重置之前都能写。
- **Linux**：网络限制要内核 6.7 以上，更早的内核只限制文件，命令也能连上引擎的端口。TCP 只按端口号限制；UDP（包括 DNS 查询）和 Unix 套接字不受限制，所以命令能用 ssh-agent 里已经加载的密钥，在 docker 组里时也能用 Docker。Landlock 只能加权限、不能扣权限：要挡读的目录如果在可写目录里面（比如把家目录当工作区打开），就挡不住。受保护文件的还原只在命令结束时做一次，命令留在后台的进程之后再改，就还原不了。
- **macOS**：沙箱只限制读写文件和联网。命令能连本机的端口和 Unix 套接字（`/var/run/docker.sock` 除外），所以也能用 ssh-agent 里已经加载的密钥。Apple 已经不推荐 `sandbox-exec`，但目前的系统上还能用。我们在 CI 的 macOS 机器上验证，没有在每个系统版本上测过。
- **三个系统都一样**：经过代理访问本机地址（`localhost`、`127.0.0.1` 等）不会问你，只有引擎自己的端口被挡住，所以命令能访问本机上的数据库、开发服务器这类服务。白名单里的网站（npm、PyPI、GitHub 等）也不会再问你，命令理论上能往这些网站发数据。`git push`、`npm publish` 这类上传命令会被权限审批认出来单独问你，但识别靠命令文本，不能当作防止数据外传的保证。命令正常结束后，它在后台启动的进程在 macOS 和 Linux 上会继续运行（仍在沙箱里），Windows 上会一起结束。

### 沙箱不管什么

- **只有智能体通过 `bash` 工具跑的命令进沙箱**。智能体改文件走的是权限审批，不经过沙箱：自动模式下，它用改文件工具直接改工作区里的 `.git/hooks` 这类以 `.` 开头的路径也不会问你，只有 MerakCode 的配置文件会先问。MCP 服务、插件、LSP、格式化工具和项目里的自定义工具都在沙箱外面运行，权限和你本人一样，只装你信任的。
- **项目自带的配置**：打开一个项目时，MerakCode 直接读取它的 `merakcode.json(c)` 和 `.merakcode/` 目录，不会先问你。里面可以放宽权限规则、关掉沙箱、加 MCP 服务（会启动本地命令）、加插件和自定义工具（代码在引擎里运行），MerakCode 还会在 `.merakcode/` 里运行 `npm install`。这些都在沙箱外。打开来路不明的仓库之前，先检查这些文件。
- **协作群成员**（Claude Code、Codex、OpenCode 和成员适配器接入的产品）跑的命令不进 MerakCode 的沙箱，Codex 的命令在 Codex 自己的沙箱里。成员要做的操作都按权限审批判断，但 MerakCode 只管得到成员主动来问的操作；一次性命令接入的自定义产品和你自己写的适配器，权限和你本人一样，只接入你信任的。
- **你自己在终端里输入的命令**不进沙箱。
- **你环境变量里的密钥**（比如 `OPENAI_API_KEY`）会传给命令，命令能读到。只有引擎自己的口令和内联配置会被去掉。命令输出交给模型之前，会把常见格式的密钥替换成 `<redacted>`（配置项 `sandbox.redactSecrets`，默认开），但这只是兜底，不保证全部拦住。
- **提示词注入**：项目文件、网页或 MCP 返回的内容可能藏着诱导模型的指令。沙箱能限制命令的破坏范围，但你批准的操作照样会执行，审批时请看清楚。

### 沙箱模式

配置项 `sandbox.mode`（也可以用环境变量 `MERAKCODE_SANDBOX_MODE` 临时覆盖）：

- `preferred`（默认）：沙箱能用就用。用不了的时候（比如 Windows 还没初始化），命令照常执行，但会改东西的命令即使在自动模式下也会先问你。
- `required`：沙箱用不了就不执行命令，提示你先初始化（你在审批里同意某条命令在沙箱外运行的除外）。
- `off`：关掉沙箱，只靠权限审批。

Windows 上要撤销沙箱，在桌面端"设置 → 权限与安全"里点"重置"，或者运行 `merak sandbox reset`，同样要同意一次管理员确认：删掉沙箱账户和它的用户配置文件、防火墙规则，收回给过的文件夹权限。

### 引擎的接口

桌面端、命令行和 SDK 启动引擎时，只监听 `127.0.0.1`，每次用一个随机端口和随机口令，口令只通过环境变量传给引擎，引擎读到后就从环境变量里删掉。终端、命令、MCP、凭据、全局配置这些接口，以及修改配置、模型服务和沙箱设置的请求，还会检查请求是不是来自启动引擎的那个程序；其他接口只靠口令。引擎自己启动的命令，即使拿到口令，也调不了这些接口和审批、提问的回复接口。

自己运行 `merak serve`（默认端口 4096）时，如果没设置 `MERAKCODE_SERVER_PASSWORD`，这台电脑上的任何程序都能调用引擎的接口，包括批准审批请求和执行命令；浏览器里来自 `localhost`、`127.0.0.1` 的网页也能跨域访问（其他来源要用 `--cors` 放行）。请设置口令（HTTP Basic 认证，用户名默认 `merakcode`）。没有口令时不要把引擎开放到局域网或公网：`--hostname`、配置里的 `server.hostname`，以及 `--mdns`（没指定地址时监听 `0.0.0.0`）都会这样做。

---

# Security

[中文](#安全)

## Reporting a vulnerability

Please do not report security problems in public issues. Go to the repository's [Security page](https://github.com/TongTong313/merakcode/security/advisories/new) and click "Report a vulnerability" to send it privately. If that doesn't work for you, email tongtong950313@gmail.com.

Include the version, your system, how to reproduce it, and what an attacker could do with it. We will reply within a week, publish details only after a fixed version is out, and credit you in the notes (tell us if you'd rather not be named).

Only the latest release gets security fixes.

## How MerakCode protects your computer

The agent reads files, edits files and runs commands on your computer. Two layers keep it in check:

1. **Permission checks**: every action goes through the permission mode (read-only, ask, auto) and your rules, which decide whether it runs, asks you first, or is refused. Commands recognised as wiping the system or formatting a disk (such as `rm -rf /` or `mkfs`) never run in any mode, unless your config explicitly allows them.
2. **The OS sandbox**: commands the agent runs through the `bash` tool run inside an operating-system sandbox. Even if you approve a bad command, what it can do is limited.

Permission checks on commands read the command text. Wrappers such as `env`, `sudo`, `nice`, `timeout` and `xargs` are judged by the command they run, commands inside `sh -c "…"` and `eval` are looked at too, and forms such as `git -C dir push` are recognised; but commands in a script file or built from variables are not seen. So the permission checks are not a security boundary; the sandbox is what limits the damage.

The sandbox is our own code, built only on what each operating system provides. It uses no third-party sandbox components.

### What the sandbox covers

- **Reading**: it cannot read the folders that hold keys: `~/.ssh`, `~/.aws`, `~/.azure`, `~/.kube`, `~/.gnupg`, `~/.docker`, `~/.config/gcloud`, `~/.config/gh`. Add more with the `sandbox.read.deny` config option (`~/` works there), but the built-in ones cannot be removed. Everything else can still be read, including `.env`, `~/.npmrc`, `~/.git-credentials` and `~/.merakcode/data/auth.json`, where MerakCode keeps your provider keys: those rely on the permission checks alone, which ask you when a command argument names them.
- **Writing**: it can only write the workspace, the system temp folder (on Linux the `/tmp` all users share; on Windows your `%TEMP%` too), package manager and app caches (`~/.npm`, `~/.cache`, `~/Library/Caches` on macOS and so on), folders you approved during a session, and folders in `sandbox.write.allow` (`~/` does not work there).
- **Protected files**: commands cannot change `.git/hooks`, `.git/config` or MerakCode's project config files (`merakcode.json`, `merakcode.jsonc`, and the same two in `.merakcode/`) in the workspace, so a command cannot plant a hook that runs the next time you commit, or loosen its own permission rules. Where the OS allows it they are blocked outright; otherwise (on Linux, and for files that did not exist yet on Windows) changes are rolled back when the command ends and reported to the model. Only those paths are covered: a `core.hooksPath` elsewhere (such as husky's `.husky/`), submodule hooks, or replacing `.git` altogether are not.
- **Network**: network traffic goes through a proxy built into the engine. Common download hosts (npm, PyPI, GitHub and so on) are allowed; anything else asks you first.
- **The engine's own API**: commands don't get the engine's password, so they can't call the engine's API or approve their own requests. On macOS and Linux (kernel 6.7 or newer) they can't even connect to the engine's port.

### Per-system details and limits

| System  | How it works                                                                                                                             | What you need to do                                                                                                                                                                   |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows | A hidden local account `merakcode-sbx`; NTFS permissions limit what it reads and writes; a firewall rule blocks its outbound connections | Set it up once from the sandbox control in the conversation composer (Settings → Permissions & security works too, or run `merak sandbox setup`) and approve one administrator prompt |
| Linux   | Landlock (kernel 5.13 or newer with Landlock enabled; needs glibc), called directly through `node:ffi`                                   | Nothing                                                                                                                                                                               |
| macOS   | The built-in Seatbelt (`sandbox-exec`)                                                                                                   | Nothing                                                                                                                                                                               |

Known limits (some of them are also listed by `merak sandbox status`):

- **Windows**: the firewall does not cover loopback, so commands can still connect directly to other services on this computer (the engine itself is password-protected). If Windows Firewall is off or replaced by another firewall, the network rule is not enforced. The sandbox account is a normal user, so it can write any folder that every user is allowed to write anyway. Write access given to the sandbox account adds up: every workspace used and every folder approved stays writable until you reset the sandbox.
- **Linux**: network rules need kernel 6.7 or newer; older kernels only get the file rules, and commands can connect to the engine's port. TCP is limited by port number only; UDP (including DNS) and Unix sockets are not limited, so commands can use keys already loaded in ssh-agent, and Docker if you are in the docker group. Landlock can only add rights, not take them away: a folder that should not be read is still readable if it is inside a writable folder (for example when your home folder is the workspace). Protected files are rolled back once, when the command ends; a process the command left running can change them afterwards.
- **macOS**: the sandbox only limits files and network. Commands can connect to local ports and Unix sockets (except `/var/run/docker.sock`), so they can use keys already loaded in ssh-agent. Apple discourages `sandbox-exec`, but it still works on current releases. We test it on the CI's macOS machines, not on every macOS version.
- **All systems**: local addresses (`localhost`, `127.0.0.1` and so on) are reached through the proxy without asking, except the engine's own port, so commands can reach databases, dev servers and other services on this computer. Allowlisted hosts (npm, PyPI, GitHub and so on) don't ask either, so in principle a command could send data to them. Upload commands such as `git push` and `npm publish` are recognised and asked about separately, but recognition reads the command text, so do not rely on it to stop data leaving. When a command ends, processes it started in the background keep running on macOS and Linux (still in the sandbox); on Windows they end with it.

### What the sandbox does not cover

- **Only commands the agent runs through the `bash` tool go into the sandbox.** File edits by the agent go through the permission checks, not the sandbox: in auto mode, the agent's edit tool changes dot paths in the workspace such as `.git/hooks` without asking; only MerakCode's config files ask first. MCP servers, plugins, LSP servers, formatters and custom project tools run outside the sandbox with your own rights. Only install ones you trust.
- **A project's own config**: when you open a project, MerakCode loads its `merakcode.json(c)` and `.merakcode/` folder without asking. They can loosen permission rules, turn the sandbox off, add MCP servers (local commands are started) and plugins or custom tools (code that runs inside the engine), and MerakCode runs `npm install` in `.merakcode/`. None of this is sandboxed. Check these files before opening a repository you don't trust.
- **Collaboration members** (Claude Code, Codex, OpenCode and products with a member adapter) run their commands outside MerakCode's sandbox; Codex runs them in its own. What a member wants to do goes through the permission checks, but MerakCode only governs what a member asks about: a custom product added as a one-shot command, or an adapter you wrote yourself, runs with your own rights. Only add ones you trust.
- **Commands you type in your own terminal** are not sandboxed.
- **Keys in your environment** (such as `OPENAI_API_KEY`) are passed to commands, which can read them. Only the engine's own password and inline config are removed. Before command output reaches the model, common key formats are replaced with `<redacted>` (the `sandbox.redactSecrets` option, on by default), but that is a safety net, not a guarantee.
- **Prompt injection**: project files, web pages or MCP results may contain text meant to steer the model. The sandbox limits the damage a command can do, but anything you approve still runs, so read approval requests carefully.

### Sandbox modes

The `sandbox.mode` config option (override it for one run with the `MERAKCODE_SANDBOX_MODE` environment variable):

- `preferred` (default): use the sandbox when it works. When it doesn't (for example before setup on Windows), commands still run, but those that may change things ask first, even in auto mode.
- `required`: if the sandbox doesn't work, refuse to run commands and ask you to set it up (except a command you approve to run outside the sandbox).
- `off`: no sandbox; rely on permission checks only.

To undo the Windows setup, click "Reset" under Settings → Permissions & security in the desktop app, or run `merak sandbox reset`, and approve one administrator prompt. It deletes the sandbox account with its user profile and the firewall rule, and takes back the folder permissions.

### The engine's API

When the desktop app, the command line or the SDK starts the engine, it listens only on `127.0.0.1`, on a random port with a random password. The password reaches the engine only through an environment variable, which the engine removes as soon as it has read it. The terminal, command, MCP, credential and global config endpoints, and requests that change config, providers or sandbox settings, also check that the request comes from the program that started the engine; other endpoints rely on the password alone. Commands the engine runs cannot reach those endpoints, or the endpoints that answer approvals and questions, even with the password.

If you run `merak serve` yourself (port 4096 by default) without setting `MERAKCODE_SERVER_PASSWORD`, any program on this computer can call the engine's API, including approving requests and running commands, and web pages served from `localhost` or `127.0.0.1` can reach it from your browser (other origins need `--cors`). Set a password (HTTP Basic auth; the user name is `merakcode` by default). Without one, never expose the engine to your network: `--hostname`, `server.hostname` in the config and `--mdns` (which listens on `0.0.0.0` when no address is given) all do.

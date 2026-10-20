# 安全

[English](#security)

## 报告漏洞

发现安全问题请不要公开提 issue。到仓库的 [Security 页面](https://github.com/TongTong313/merakcode/security/advisories/new) 点 "Report a vulnerability" 私下提交；用不了的话发邮件到 tongtong950313@gmail.com。

请写上：哪个版本、什么系统、怎么复现、可能造成什么后果。我们会在一周内回复，修好并发布新版本之后再公开细节，并在说明里感谢你（不想署名可以说一声）。

只有最新发布的版本会收到安全修复。

## MerakCode 怎么保护你的电脑

智能体会在你的电脑上读文件、改文件、跑命令。我们靠两道关来管住它：

1. **权限审批**：每个操作先按权限模式（只读、询问、自动）和你的规则判断，是直接做、先问你，还是不做。删系统、格式化磁盘这类命令默认在任何模式下都不执行，只有你在配置里明确放行才会跑。
2. **系统沙箱**：智能体通过 `bash` 工具跑的命令，放进操作系统层面的沙箱里执行。就算你批准了一条有问题的命令，它能做的事也有限。

沙箱是我们自己写的，只用操作系统自带的能力，没有用第三方沙箱组件。

### 沙箱管什么

- **读**：读不到放密钥的目录：`~/.ssh`、`~/.aws`、`~/.azure`、`~/.kube`、`~/.gnupg`、`~/.docker`、`~/.config/gcloud`、`~/.config/gh`。可以在配置 `sandbox.read.deny` 里加更多。其他文件照常能读。
- **写**：只能写工作区、沙箱的临时目录、包管理器缓存（如 `~/.npm`、`~/.cache`）、你在审批时同意的目录，以及配置 `sandbox.write.allow` 里的目录。
- **Git**：工作区里的 `.git/hooks` 和 `.git/config` 不能改，防止命令偷偷装一个钩子，等你下次提交时执行。
- **联网**：命令的网络请求要经过引擎内置的代理。npm、PyPI、GitHub 等常用的下载地址直接放行，其他网站先问你。
- **引擎自己的接口**：命令拿不到引擎的口令，调不了引擎的接口，也就没法替自己批准审批请求。在 Linux 和 macOS 上，命令连引擎的端口都连不上。

### 各系统的实现和限制

| 系统    | 实现                                                                                   | 需要做什么                                         |
| ------- | -------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Windows | 一个隐藏的本地账户 `merakcode-sbx`，用 NTFS 权限限制读写，用防火墙规则拦截它的出站连接 | 运行一次 `merak sandbox setup`，同意一次管理员确认 |
| Linux   | Landlock（内核 5.13 以上）                                                             | 不用设置                                           |
| macOS   | 系统自带的 Seatbelt（`sandbox-exec`）                                                  | 不用设置                                           |

已知的限制（`merak sandbox status` 也会列出来）：

- **Windows**：防火墙管不到本机回环地址，所以命令还能连这台电脑上的其他服务（引擎本身有口令保护）。沙箱账户是一个普通用户：系统里本来就允许所有用户写的文件夹，它也能写。
- **Linux**：网络限制要内核 6.7 以上，更早的内核只限制文件。TCP 只按端口号限制；UDP（包括 DNS 查询）和 Unix 套接字不受限制。
- **macOS**：Apple 已经不推荐 `sandbox-exec`，但目前的系统上还能用。我们在 CI 的 macOS 机器上验证，没有在每个系统版本上测过。
- **三个系统都一样**：白名单里的网站（npm、PyPI、GitHub 等）不会再问你，命令理论上也能往这些网站发数据。`git push`、`npm publish` 这类上传命令由权限审批单独拦一道。

### 沙箱不管什么

- **只有智能体通过 `bash` 工具跑的命令进沙箱**。智能体改文件走的是权限审批，不经过沙箱。MCP 服务、插件、LSP、格式化工具和项目里的自定义工具都在沙箱外面运行，权限和你本人一样，只装你信任的。
- **你自己在终端里输入的命令**不进沙箱。
- **你环境变量里的密钥**（比如 `OPENAI_API_KEY`）会传给命令，命令能读到。只有引擎自己的口令和内联配置会被去掉。命令输出交给模型之前，会把常见格式的密钥替换成 `<redacted>`（配置项 `sandbox.redactSecrets`，默认开），但这只是兜底，不保证全部拦住。
- **提示词注入**：项目文件、网页或 MCP 返回的内容可能藏着诱导模型的指令。沙箱能限制命令的破坏范围，但你批准的操作照样会执行，审批时请看清楚。

### 沙箱模式

配置项 `sandbox.mode`（也可以用环境变量 `MERAKCODE_SANDBOX_MODE` 临时覆盖）：

- `preferred`（默认）：沙箱能用就用。用不了的时候（比如 Windows 还没初始化），命令照常执行，但会改东西的命令即使在自动模式下也会先问你。
- `required`：沙箱用不了就不执行命令，提示你先初始化。
- `off`：关掉沙箱，只靠权限审批。

Windows 上要撤销沙箱，运行 `merak sandbox reset`：删掉沙箱账户和防火墙规则，收回给过的文件夹权限。

### 引擎的接口

终端界面、桌面端和 SDK 启动引擎时，只监听 `127.0.0.1`，每次用一个随机端口和随机口令，口令只通过环境变量传给引擎，引擎读到后就从环境变量里删掉。改配置、装 MCP、开终端这些高风险接口，还会检查请求是不是来自启动它的那个程序。

自己运行 `merak serve` 时，如果没设置 `MERAKCODE_SERVER_PASSWORD`，这台电脑上的任何程序都能调用引擎的接口，包括批准审批请求。请设置口令；不要在没有口令的情况下用 `--hostname` 把引擎开放到局域网或公网。

---

# Security

## Reporting a vulnerability

Please do not report security problems in public issues. Go to the repository's [Security page](https://github.com/TongTong313/merakcode/security/advisories/new) and click "Report a vulnerability" to send it privately. If that doesn't work for you, email tongtong950313@gmail.com.

Include the version, your system, how to reproduce it, and what an attacker could do with it. We will reply within a week, publish details only after a fixed version is out, and credit you in the notes (tell us if you'd rather not be named).

Only the latest release gets security fixes.

## How MerakCode protects your computer

The agent reads files, edits files and runs commands on your computer. Two layers keep it in check:

1. **Permission checks**: every action goes through the permission mode (read-only, ask, auto) and your rules, which decide whether it runs, asks you first, or is refused. Commands that wipe the system or format a disk never run in any mode, unless your config explicitly allows them.
2. **The OS sandbox**: commands the agent runs through the `bash` tool run inside an operating-system sandbox. Even if you approve a bad command, what it can do is limited.

The sandbox is our own code, built only on what each operating system provides. It uses no third-party sandbox components.

### What the sandbox covers

- **Reading**: it cannot read the folders that hold keys: `~/.ssh`, `~/.aws`, `~/.azure`, `~/.kube`, `~/.gnupg`, `~/.docker`, `~/.config/gcloud`, `~/.config/gh`. Add more with the `sandbox.read.deny` config option. Everything else can still be read.
- **Writing**: it can only write the workspace, the sandbox temp folder, package manager caches (such as `~/.npm` and `~/.cache`), folders you approved during a session, and folders in `sandbox.write.allow`.
- **Git**: `.git/hooks` and `.git/config` in the workspace cannot be changed, so a command cannot plant a hook that runs the next time you commit.
- **Network**: network traffic goes through a proxy built into the engine. Common download hosts (npm, PyPI, GitHub and so on) are allowed; anything else asks you first.
- **The engine's own API**: commands don't get the engine's password, so they can't call the engine's API or approve their own requests. On Linux and macOS they can't even connect to the engine's port.

### Per-system details and limits

| System  | How it works                                                                                                                             | What you need to do                                                 |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Windows | A hidden local account `merakcode-sbx`; NTFS permissions limit what it reads and writes; a firewall rule blocks its outbound connections | Run `merak sandbox setup` once and approve one administrator prompt |
| Linux   | Landlock (kernel 5.13 or newer)                                                                                                          | Nothing                                                             |
| macOS   | The built-in Seatbelt (`sandbox-exec`)                                                                                                   | Nothing                                                             |

Known limits (`merak sandbox status` lists them too):

- **Windows**: the firewall does not cover loopback, so commands can still reach other services on this computer (the engine itself is password-protected). The sandbox account is a normal user, so it can write any folder that every user is allowed to write anyway.
- **Linux**: network rules need kernel 6.7 or newer; older kernels only get the file rules. TCP is limited by port number only; UDP (including DNS) and Unix sockets are not limited.
- **macOS**: Apple discourages `sandbox-exec`, but it still works on current releases. We test it on the CI's macOS machines, not on every macOS version.
- **All systems**: allowlisted hosts (npm, PyPI, GitHub and so on) don't ask, so in principle a command could send data to them. Upload commands such as `git push` and `npm publish` are caught separately by the permission checks.

### What the sandbox does not cover

- **Only commands the agent runs through the `bash` tool go into the sandbox.** File edits by the agent go through the permission checks, not the sandbox. MCP servers, plugins, LSP servers, formatters and custom project tools run outside the sandbox with your own rights. Only install ones you trust.
- **Commands you type in your own terminal** are not sandboxed.
- **Keys in your environment** (such as `OPENAI_API_KEY`) are passed to commands, which can read them. Only the engine's own password and inline config are removed. Before command output reaches the model, common key formats are replaced with `<redacted>` (the `sandbox.redactSecrets` option, on by default), but that is a safety net, not a guarantee.
- **Prompt injection**: project files, web pages or MCP results may contain text meant to steer the model. The sandbox limits the damage a command can do, but anything you approve still runs, so read approval requests carefully.

### Sandbox modes

The `sandbox.mode` config option (override it for one run with the `MERAKCODE_SANDBOX_MODE` environment variable):

- `preferred` (default): use the sandbox when it works. When it doesn't (for example before setup on Windows), commands still run, but those that may change things ask first, even in auto mode.
- `required`: if the sandbox doesn't work, refuse to run commands and ask you to set it up.
- `off`: no sandbox; rely on permission checks only.

To undo the Windows setup, run `merak sandbox reset`. It deletes the sandbox account and firewall rule and takes back the folder permissions.

### The engine's API

When the terminal UI, the desktop app or the SDK starts the engine, it listens only on `127.0.0.1`, on a random port with a random password. The password reaches the engine only through an environment variable, which the engine removes as soon as it has read it. High-risk endpoints (changing config, installing MCP servers, opening terminals) also check that the request comes from the program that started the engine.

If you run `merak serve` yourself without setting `MERAKCODE_SERVER_PASSWORD`, any program on this computer can call the engine's API, including approving requests. Set a password, and never expose the engine to your network or the internet with `--hostname` without one.

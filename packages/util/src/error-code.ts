/**
 * Every error a user can see carries a stable code like MRK-2002. The code is what people quote in bug reports
 * and search for in docs/errors.md, so codes are never reused or renumbered.
 *
 * Thousands digit = domain: 1 engine and connection, 2 model provider, 3 config, 4 session, 5 tools, permissions
 * and sandbox, 6 extensions (MCP, plugins, skills), 7 workspace and git, 8 install and update, 9 internal.
 */
export namespace ErrorCode {
  type Text = { zh: string; en: string }
  type Domain =
    "engine" | "provider" | "config" | "session" | "tool" | "extension" | "workspace" | "update" | "internal"
  export type Spec = {
    code: `MRK-${number}`
    domain: Domain
    /** HTTP status the server answers with */
    status: number
    retryable: boolean
    title: Text
    /** What the user can do about it */
    hint: Text
    /** Names of the error classes (NamedError) that carry this code */
    errors?: string[]
  }

  export const CATALOG = {
    ENGINE_NOT_FOUND: {
      code: "MRK-1001",
      domain: "engine",
      status: 500,
      retryable: false,
      title: { zh: "找不到引擎", en: "Engine not found" },
      hint: {
        zh: "本机对应的引擎包没装上。重新安装，或用 executablePath 指定引擎。",
        en: "The engine package for this platform is not installed. Reinstall, or pass executablePath.",
      },
    },
    ENGINE_START_TIMEOUT: {
      code: "MRK-1002",
      domain: "engine",
      status: 504,
      retryable: true,
      title: { zh: "引擎启动超时", en: "Engine took too long to start" },
      hint: {
        zh: "稍后重试；反复出现时运行 merak doctor 看看。",
        en: "Try again; if it keeps happening, run merak doctor.",
      },
    },
    ENGINE_START_FAILED: {
      code: "MRK-1003",
      domain: "engine",
      status: 500,
      retryable: false,
      title: { zh: "引擎没能启动", en: "Engine failed to start" },
      hint: {
        zh: "报错里附了引擎最后几行输出；运行 merak logs 可以看完整日志。",
        en: "The error includes the engine's last output lines; run merak logs for the full log.",
      },
    },
    ENGINE_EXITED: {
      code: "MRK-1004",
      domain: "engine",
      status: 503,
      retryable: true,
      title: { zh: "引擎意外退出", en: "Engine exited unexpectedly" },
      hint: { zh: "运行 merak bug-report 打包日志反馈给我们。", en: "Run merak bug-report and send us the bundle." },
    },
    UNAUTHORIZED: {
      code: "MRK-1005",
      domain: "engine",
      status: 401,
      retryable: false,
      title: { zh: "引擎口令不对", en: "Wrong engine password" },
      hint: {
        zh: "客户端和引擎的口令对不上，多半是连到了别的进程启动的引擎。重启桌面端，或者重新运行刚才的命令；自己连引擎时检查 MERAKCODE_SERVER_PASSWORD。",
        en: "The client and the engine disagree on the password, usually because you reached an engine another process started. Restart the desktop app or run the command again; if you connect yourself, check MERAKCODE_SERVER_PASSWORD.",
      },
    },
    FORBIDDEN: {
      code: "MRK-1006",
      domain: "engine",
      status: 403,
      retryable: false,
      title: { zh: "不允许从这里访问", en: "Not allowed from this process" },
      hint: {
        zh: "引擎不接受由它自己启动的命令发来的这类请求，防止模型绕过权限。请在 merak 界面或你自己的程序里操作。",
        en: "The engine refuses this request from commands it started itself, so the model cannot get around permissions. Do it from the merak UI or your own program.",
      },
    },
    REQUEST_TIMEOUT: {
      code: "MRK-1007",
      domain: "engine",
      status: 504,
      retryable: true,
      title: { zh: "请求超时", en: "Request timed out" },
      hint: {
        zh: "引擎太忙或卡住了。稍后重试；反复出现时运行 merak doctor。",
        en: "The engine is busy or stuck. Try again; if it keeps happening, run merak doctor.",
      },
    },
    EVENT_STREAM_LOST: {
      code: "MRK-1008",
      domain: "engine",
      status: 503,
      retryable: true,
      title: { zh: "和引擎的连接断了", en: "Lost the connection to the engine" },
      hint: {
        zh: "引擎可能已经退出。重启桌面端，或者重新运行刚才的命令；反复出现时运行 merak bug-report 反馈给我们。",
        en: "The engine may have exited. Restart the desktop app or run the command again; if it keeps happening, run merak bug-report and send us the bundle.",
      },
    },
    BAD_REQUEST: {
      code: "MRK-1009",
      domain: "engine",
      status: 400,
      retryable: false,
      title: { zh: "请求参数不对", en: "Invalid request" },
      errors: ["BadRequestError"],
      hint: {
        zh: "报错信息里写了哪个参数不对。用 SDK 时检查传进去的参数。",
        en: "The message says which field is wrong. If you use the SDK, check what you passed in.",
      },
    },
    INCOMPATIBLE_VERSION: {
      code: "MRK-1010",
      domain: "engine",
      status: 400,
      retryable: false,
      title: { zh: "SDK 和引擎版本不一致", en: "SDK and engine versions do not match" },
      hint: { zh: "把 SDK 和引擎装成同一个版本。", en: "Install the same version of the SDK and the engine." },
    },
    NOT_FOUND: {
      code: "MRK-1011",
      domain: "engine",
      status: 404,
      retryable: false,
      title: { zh: "要找的东西不存在", en: "Not found" },
      hint: {
        zh: "会话、消息或文件可能已经被删掉了。刷新后再试。",
        en: "The session, message or file may have been deleted. Refresh and try again.",
      },
      errors: ["NotFoundError"],
    },

    PROVIDER_AUTH_FAILED: {
      code: "MRK-2001",
      domain: "provider",
      // Not 401: that would read as a wrong engine password to clients
      status: 502,
      retryable: false,
      title: { zh: "模型服务登录失败", en: "Model provider sign-in failed" },
      hint: {
        zh: "检查 API 密钥是否正确、是否过期；在 /provider 里重新连接。",
        en: "Check that the API key is correct and not expired; reconnect in /provider.",
      },
      errors: [
        "ProviderAuthError",
        "ProviderAuthOauthMissing",
        "ProviderAuthOauthCodeMissing",
        "ProviderAuthOauthCallbackFailed",
      ],
    },
    MODEL_NOT_FOUND: {
      code: "MRK-2002",
      domain: "provider",
      status: 400,
      retryable: false,
      title: { zh: "找不到这个模型", en: "Model not found" },
      hint: { zh: "运行 merak models 查看可用的模型。", en: "Run merak models to list the available models." },
      errors: ["ProviderModelNotFoundError", "ModelNotFoundError"],
    },
    PROVIDER_INIT_FAILED: {
      code: "MRK-2003",
      domain: "provider",
      status: 500,
      retryable: false,
      title: { zh: "模型服务初始化失败", en: "Model provider failed to initialize" },
      hint: { zh: "检查这个服务的配置和密钥。", en: "Check this provider's configuration and credentials." },
      errors: ["ProviderInitError"],
    },
    RATE_LIMITED: {
      code: "MRK-2004",
      domain: "provider",
      status: 429,
      retryable: true,
      title: { zh: "请求太频繁，被模型服务限流了", en: "Rate limited by the model provider" },
      hint: { zh: "等一会儿再试，或换一个模型。", en: "Wait a moment and try again, or switch models." },
    },
    CONTEXT_OVERFLOW: {
      code: "MRK-2005",
      domain: "provider",
      status: 400,
      retryable: false,
      title: { zh: "对话太长，超出模型的上下文", en: "The conversation is too long for this model" },
      hint: { zh: "用 /compact 压缩对话，或开一个新会话。", en: "Run /compact, or start a new session." },
      errors: ["ContextOverflowError", "CompactionBlockedError"],
    },
    PROVIDER_REQUEST_FAILED: {
      code: "MRK-2006",
      domain: "provider",
      status: 502,
      retryable: true,
      title: { zh: "模型服务返回了错误", en: "The model provider returned an error" },
      hint: {
        zh: "看报错里模型服务返回的原话。多数是服务那边临时出问题，稍后重试即可。",
        en: "Read the provider's own message in the error. Most of the time it is a temporary problem on their side; try again later.",
      },
      errors: ["APIError"],
    },
    NO_MODEL: {
      code: "MRK-2007",
      domain: "provider",
      status: 400,
      retryable: false,
      title: { zh: "还没有可用的模型", en: "No model is available" },
      hint: { zh: "先在 /provider 里连接一个模型服务。", en: "Connect a model provider in /provider first." },
      errors: ["ProviderNoModelError"],
    },
    OUTPUT_TRUNCATED: {
      code: "MRK-2008",
      domain: "provider",
      status: 500,
      retryable: false,
      title: { zh: "模型输出被截断了", en: "The model's output was cut off" },
      hint: {
        zh: "模型一次写不完。让它分几步做，或换一个输出上限更大的模型。",
        en: "The model ran out of room for its answer. Ask for the work in smaller steps, or use a model with a larger output limit.",
      },
      errors: ["MessageOutputLengthError"],
    },
    STRUCTURED_OUTPUT_FAILED: {
      code: "MRK-2009",
      domain: "provider",
      status: 500,
      retryable: false,
      title: { zh: "模型没有按要求的格式回答", en: "The model did not answer in the required format" },
      hint: {
        zh: "重试一次；反复出现时换一个能力更强的模型。",
        en: "Try again; if it keeps happening, use a stronger model.",
      },
      errors: ["StructuredOutputError"],
    },
    CATALOG_REFRESH_FAILED: {
      code: "MRK-2010",
      domain: "provider",
      status: 502,
      retryable: true,
      title: { zh: "模型列表没有拉下来", en: "Could not refresh the model list" },
      hint: {
        zh: "检查网络，稍后再试。",
        en: "Check the network and try again.",
      },
      errors: ["CatalogRefreshError"],
    },

    CONFIG_JSON_INVALID: {
      code: "MRK-3001",
      domain: "config",
      status: 400,
      retryable: false,
      title: { zh: "配置文件不是合法的 JSON", en: "The config file is not valid JSON" },
      hint: { zh: "报错里有文件路径，按提示修好再试。", en: "The error names the file; fix it and try again." },
      errors: ["ConfigJsonError", "ConfigParseError"],
    },
    CONFIG_INVALID: {
      code: "MRK-3002",
      domain: "config",
      status: 400,
      retryable: false,
      title: { zh: "配置项写得不对", en: "The configuration is invalid" },
      hint: {
        zh: "报错里列出了哪个文件的哪一项不对，按提示修改。配置文件里写上 $schema，编辑器就会提示正确写法。",
        en: "The error lists which setting in which file is wrong. Add $schema to the config file and your editor will show the valid values.",
      },
      errors: ["ConfigInvalidError"],
    },
    CONFIG_DIRECTORY_TYPO: {
      code: "MRK-3003",
      domain: "config",
      status: 400,
      retryable: false,
      title: { zh: "配置目录的名字拼错了", en: "A config directory name is misspelled" },
      hint: {
        zh: "报错里给出了正确的目录名，把目录改过来，或者删掉它。",
        en: "The error names the correct directory. Rename the directory to it, or remove it.",
      },
      errors: ["ConfigDirectoryTypoError"],
    },
    CONFIG_FRONTMATTER_INVALID: {
      code: "MRK-3004",
      domain: "config",
      status: 400,
      retryable: false,
      title: { zh: "Markdown 文件开头的配置写得不对", en: "A Markdown file's front matter is invalid" },
      hint: {
        zh: "文件开头两行 --- 之间的内容必须是合法的 YAML，按报错提示修改。",
        en: "The block between the two --- lines at the top of the file must be valid YAML. Fix it as the error says.",
      },
      errors: ["ConfigFrontmatterError"],
    },

    SESSION_READ_FAILED: {
      code: "MRK-4001",
      domain: "session",
      status: 500,
      retryable: false,
      title: { zh: "读取会话失败", en: "Could not read the session" },
      hint: {
        zh: "会话数据可能损坏了。运行 merak bug-report 打包日志反馈给我们。",
        en: "The session data may be damaged. Run merak bug-report and send us the bundle.",
      },
      errors: ["SessionReadError"],
    },
    ABORTED: {
      code: "MRK-4002",
      domain: "session",
      status: 499,
      retryable: false,
      title: { zh: "已中止", en: "Stopped" },
      hint: {
        zh: "你或你的程序主动停下了这次回答，不需要处理。",
        en: "You or your program stopped the reply. Nothing to fix.",
      },
      errors: ["MessageAbortedError"],
    },
    AGENT_NOT_FOUND: {
      code: "MRK-4003",
      domain: "session",
      status: 400,
      retryable: false,
      title: { zh: "找不到这个智能体", en: "Agent not found" },
      hint: { zh: "运行 merak agent list 查看可用的智能体。", en: "Run merak agent list to see the available agents." },
      errors: ["AgentNotFoundError"],
    },
    COMMAND_NOT_FOUND: {
      code: "MRK-4004",
      domain: "session",
      status: 400,
      retryable: false,
      title: { zh: "找不到这个命令", en: "Command not found" },
      hint: { zh: "输入 / 查看可用的命令。", en: "Type / to see the available commands." },
      errors: ["CommandNotFoundError"],
    },
    REVERT_FAILED: {
      code: "MRK-4005",
      domain: "session",
      status: 500,
      retryable: false,
      title: { zh: "撤销改动失败", en: "Could not undo the changes" },
      hint: {
        zh: "可能有文件正被别的程序占用或修改。关掉占用的程序后重试。",
        en: "A file may be open or being changed by another program. Close it and try again.",
      },
      errors: ["RevertFailedError"],
    },

    PERMISSION_REJECTED: {
      code: "MRK-5001",
      domain: "tool",
      status: 403,
      retryable: false,
      title: { zh: "操作被拒绝", en: "The operation was rejected" },
      hint: {
        zh: "你拒绝了这次操作，或者权限规则不允许。确实需要时，修改配置里的 permission。",
        en: "You declined it, or a permission rule blocks it. If it should be allowed, change permission in the config.",
      },
    },
    READONLY_FORBIDDEN: {
      code: "MRK-5002",
      domain: "tool",
      status: 403,
      retryable: false,
      title: { zh: "只读模式下不能这样做", en: "Not allowed in read-only mode" },
      hint: { zh: "按 Shift+Tab 切换权限模式。", en: "Press Shift+Tab to switch the permission mode." },
    },
    SANDBOX_UNAVAILABLE: {
      code: "MRK-5003",
      domain: "tool",
      status: 500,
      retryable: false,
      title: { zh: "沙箱用不了", en: "The sandbox is unavailable" },
      hint: { zh: "运行 merak sandbox status 查看原因。", en: "Run merak sandbox status to see why." },
    },
    SANDBOX_WRITE_BLOCKED: {
      code: "MRK-5004",
      domain: "tool",
      status: 403,
      retryable: false,
      title: { zh: "沙箱拦下了一次写文件", en: "The sandbox blocked a file write" },
      hint: {
        zh: "命令想写工作区以外的地方。确实需要时，把那个目录加到配置的 sandbox.write.allow 里。",
        en: "The command tried to write outside the workspace. If it really needs to, add that directory to sandbox.write.allow in the config.",
      },
    },
    SANDBOX_NETWORK_BLOCKED: {
      code: "MRK-5005",
      domain: "tool",
      status: 403,
      retryable: false,
      title: { zh: "沙箱拦下了一次联网", en: "The sandbox blocked a network connection" },
      hint: {
        zh: "命令想连一个没被允许的网址。确实需要时，在提示时选择允许，或在配置的 permission 里放行这个网址。",
        en: "The command tried to reach an address that is not allowed. If it really needs to, allow it when asked, or allow it under permission in the config.",
      },
    },
    SANDBOX_READ_BLOCKED: {
      code: "MRK-5006",
      domain: "tool",
      status: 403,
      retryable: false,
      title: { zh: "沙箱拦下了一次读文件", en: "The sandbox blocked a file read" },
      hint: {
        zh: "命令想读密钥一类的敏感目录（比如 ~/.ssh）。这是故意拦的；确实需要时，改配置的 sandbox.read.deny。",
        en: "The command tried to read a sensitive directory such as ~/.ssh. This is on purpose; if it really needs to, change sandbox.read.deny in the config.",
      },
    },
    SANDBOX_SETUP_REQUIRED: {
      code: "MRK-5007",
      domain: "tool",
      status: 412,
      retryable: false,
      title: { zh: "沙箱还没初始化", en: "The sandbox has not been set up" },
      errors: ["SandboxSetupRequiredError"],
      hint: {
        zh: "在桌面端「设置 → 权限与安全」里点「初始化」，或者运行 merak sandbox setup。",
        en: "In the desktop app, open Settings → Permissions & security and click Set up, or run merak sandbox setup.",
      },
    },
    TOOL_FAILED: {
      code: "MRK-5010",
      domain: "tool",
      status: 500,
      retryable: false,
      title: { zh: "工具运行出错", en: "A tool failed" },
      hint: {
        zh: "报错里有工具自己的输出，按它的提示处理。模型通常会自己换个办法再试。",
        en: "The error includes the tool's own output; follow it. The model usually tries another way by itself.",
      },
    },
    TOOL_TIMEOUT: {
      code: "MRK-5011",
      domain: "tool",
      status: 504,
      retryable: true,
      title: { zh: "工具运行超时", en: "A tool timed out" },
      hint: {
        zh: "命令跑得太久被停掉了。耗时长的命令可以让模型放到后台运行。",
        en: "The command ran too long and was stopped. Ask the model to run long commands in the background.",
      },
    },
    RIPGREP_UNAVAILABLE: {
      code: "MRK-5020",
      domain: "tool",
      status: 500,
      retryable: true,
      title: { zh: "搜索工具 ripgrep 用不了", en: "The ripgrep search tool is unavailable" },
      hint: {
        zh: "离线或内网环境可以设置 MERAKCODE_RIPGREP_BASE_URL 指向镜像。",
        en: "Offline or behind a firewall, point MERAKCODE_RIPGREP_BASE_URL at a mirror.",
      },
      errors: ["RipgrepExtractionFailedError", "RipgrepUnsupportedPlatformError", "RipgrepDownloadFailedError"],
    },
    LSP_FAILED: {
      code: "MRK-5030",
      domain: "tool",
      status: 500,
      retryable: false,
      title: { zh: "语言服务器启动失败", en: "A language server failed to start" },
      hint: {
        zh: "检查对应语言的工具是否装好（比如 typescript、pyright）。不影响其他功能。",
        en: "Check that the language's tooling is installed (for example typescript or pyright). Everything else keeps working.",
      },
      errors: ["LSPInitializeError"],
    },

    MCP_FAILED: {
      code: "MRK-6001",
      domain: "extension",
      status: 502,
      retryable: true,
      title: { zh: "MCP 服务出错", en: "An MCP server failed" },
      hint: {
        zh: "检查这个 MCP 服务的命令、地址和密钥。用 merak mcp list 查看它的状态。",
        en: "Check the MCP server's command, URL and credentials. Run merak mcp list to see its status.",
      },
      errors: ["MCPFailed"],
    },
    MCP_NOT_FOUND: {
      code: "MRK-6002",
      domain: "extension",
      status: 404,
      retryable: false,
      title: { zh: "找不到这个 MCP 服务", en: "MCP server not found" },
      hint: {
        zh: "配置里没有这个名字的 MCP 服务。用 merak mcp list 查看已配置的服务。",
        en: "There is no MCP server with that name in the config. Run merak mcp list to see the configured servers.",
      },
      errors: ["McpServerNotFoundError"],
    },
    MCP_OAUTH_UNSUPPORTED: {
      code: "MRK-6003",
      domain: "extension",
      status: 400,
      retryable: false,
      title: { zh: "这个 MCP 服务不支持 OAuth 登录", en: "This MCP server does not support OAuth" },
      hint: {
        zh: "这个服务要用 API 密钥之类的方式登录，在它的配置里写上 headers。",
        en: "This server needs another way to sign in, such as an API key; set headers in its config.",
      },
      errors: ["McpUnsupportedOAuthError"],
    },
    PLUGIN_INSTALL_FAILED: {
      code: "MRK-6004",
      domain: "extension",
      status: 502,
      retryable: true,
      title: { zh: "插件或依赖装不上", en: "Could not install a plugin or package" },
      hint: { zh: "检查网络，或换一个 npm 镜像。", en: "Check the network, or use another npm registry." },
      errors: ["PluginInstallError", "PackageInstallFailedError"],
    },
    SKILL_INVALID: {
      code: "MRK-6005",
      domain: "extension",
      status: 400,
      retryable: false,
      title: { zh: "技能文件写得不对", en: "A skill file is invalid" },
      hint: {
        zh: "检查 SKILL.md 开头的 name 和 description，name 要和所在目录同名。",
        en: "Check name and description at the top of SKILL.md; name must match the directory name.",
      },
      errors: ["SkillInvalidError", "SkillNameMismatchError"],
    },

    WORKTREE_NOT_GIT: {
      code: "MRK-7001",
      domain: "workspace",
      status: 400,
      retryable: false,
      title: { zh: "这里不是 git 仓库", en: "This is not a git repository" },
      hint: {
        zh: "工作树功能需要 git 仓库。先在项目里运行 git init。",
        en: "Worktrees need a git repository. Run git init in the project first.",
      },
      errors: ["WorktreeNotGitError"],
    },
    WORKTREE_FAILED: {
      code: "MRK-7002",
      domain: "workspace",
      status: 400,
      retryable: false,
      title: { zh: "工作树操作失败", en: "A worktree operation failed" },
      hint: { zh: "报错里有 git 的原话，按它的提示处理。", en: "The error includes git's own message; follow it." },
      errors: [
        "WorktreeNameGenerationFailedError",
        "WorktreeCreateFailedError",
        "WorktreeStartCommandFailedError",
        "WorktreeRemoveFailedError",
        "WorktreeResetFailedError",
      ],
    },
    WORKTREE_DIRTY: {
      code: "MRK-7003",
      domain: "workspace",
      status: 409,
      retryable: false,
      title: { zh: "工作树里有没提交的改动", en: "The worktree has uncommitted changes" },
      hint: {
        zh: "先提交或丢弃工作树里的改动，再重置。",
        en: "Commit or discard the changes in the worktree first, then reset it.",
      },
      errors: ["WorktreeResetDirtyError"],
    },
    REVIEW_STALE: {
      code: "MRK-7004",
      domain: "workspace",
      status: 409,
      retryable: true,
      title: { zh: "文件在审阅期间被改过了", en: "Files changed while being reviewed" },
      hint: {
        zh: "刷新审阅页面，按最新的文件内容重新审阅。",
        en: "Refresh the review and go through the latest version of the files.",
      },
      errors: ["ReviewStaleError"],
    },
    REVIEW_INVALID: {
      code: "MRK-7005",
      domain: "workspace",
      status: 400,
      retryable: false,
      title: { zh: "审阅请求不对", en: "Invalid review request" },
      hint: {
        zh: "报错信息里写了哪里不对。用 SDK 时检查传进去的参数。",
        en: "The message says what is wrong. If you use the SDK, check what you passed in.",
      },
      errors: ["ReviewInvalidError"],
    },

    UPDATE_CHECK_FAILED: {
      code: "MRK-8001",
      domain: "update",
      status: 502,
      retryable: true,
      title: { zh: "检查更新失败", en: "Could not check for updates" },
      hint: {
        zh: "检查网络，稍后再试。也可以到发布页手动下载新版本。",
        en: "Check the network and try again later, or download the new version from the releases page.",
      },
    },
    UPDATE_DOWNLOAD_FAILED: {
      code: "MRK-8002",
      domain: "update",
      status: 502,
      retryable: true,
      title: { zh: "下载更新失败", en: "Could not download the update" },
      hint: {
        zh: "检查网络，稍后再试。也可以到发布页手动下载新版本。",
        en: "Check the network and try again later, or download the new version from the releases page.",
      },
    },
    UPDATE_CHECKSUM_MISMATCH: {
      code: "MRK-8003",
      domain: "update",
      status: 502,
      retryable: true,
      title: { zh: "更新包校验不通过", en: "The update failed its checksum" },
      hint: { zh: "下载可能不完整，重试一次。", en: "The download may be incomplete; try again." },
    },
    UPDATE_INSTALL_FAILED: {
      code: "MRK-8004",
      domain: "update",
      status: 500,
      retryable: false,
      title: { zh: "安装更新失败", en: "Could not install the update" },
      hint: {
        zh: "报错里有安装命令的输出。没有写权限时用管理员身份重试，或到发布页手动下载。",
        en: "The error includes the installer's output. If it lacks write permission, retry as administrator, or download from the releases page.",
      },
      errors: ["UpgradeFailedError"],
    },
    UPDATE_UNSUPPORTED: {
      code: "MRK-8005",
      domain: "update",
      status: 400,
      retryable: false,
      title: { zh: "这种安装方式不能自动升级", en: "This installation cannot update itself" },
      hint: { zh: "到发布页下载新版本。", en: "Download the new version from the releases page." },
    },
    NETWORK_UNREACHABLE: {
      code: "MRK-8006",
      domain: "update",
      status: 502,
      retryable: true,
      title: { zh: "连不上 GitHub 或 npm", en: "Cannot reach GitHub or npm" },
      hint: {
        zh: "检查网络。需要走代理时设置 HTTPS_PROXY；用 npm 镜像时设置 npm 的 registry。",
        en: "Check the network. Behind a proxy, set HTTPS_PROXY; with an npm mirror, set npm's registry.",
      },
    },

    INTERNAL: {
      code: "MRK-9000",
      domain: "internal",
      status: 500,
      retryable: false,
      title: { zh: "出了意料之外的错误", en: "Something unexpected went wrong" },
      hint: {
        zh: "运行 merak bug-report 打包日志反馈给我们。",
        en: "Run merak bug-report and send us the bundle.",
      },
      errors: ["UnknownError"],
    },
    LOG_DIR_NOT_WRITABLE: {
      code: "MRK-9001",
      domain: "internal",
      status: 500,
      retryable: false,
      title: { zh: "日志文件夹写不进去", en: "The log folder is not writable" },
      hint: {
        zh: "检查这个文件夹的权限和磁盘空间，或用 MERAKCODE_LOG_ROOT 换一个位置。",
        en: "Check the folder's permissions and free disk space, or move it with MERAKCODE_LOG_ROOT.",
      },
    },
  } as const satisfies Record<string, Spec>

  export type Name = keyof typeof CATALOG

  const byError = new Map<string, Spec>(
    Object.values(CATALOG as Record<string, Spec>).flatMap((spec) => (spec.errors ?? []).map((name) => [name, spec])),
  )
  const byCode = new Map<string, Spec>(Object.values(CATALOG as Record<string, Spec>).map((spec) => [spec.code, spec]))

  /** Code for an error class name; provider API errors are classified by their HTTP status */
  export function of(name: string, data?: unknown): string {
    const status = (data as { statusCode?: unknown } | undefined)?.statusCode
    if (name === "APIError" || name === "CatalogRefreshError") {
      if (status === 429) return CATALOG.RATE_LIMITED.code
      if (status === 401 || status === 403) return CATALOG.PROVIDER_AUTH_FAILED.code
    }
    return byError.get(name)?.code ?? CATALOG.INTERNAL.code
  }

  export function spec(code: string): Spec | undefined {
    return byCode.get(code)
  }
}

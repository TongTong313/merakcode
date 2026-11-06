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
  }

  export const CATALOG = {
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
    },
  } as const satisfies Record<string, Spec>
}

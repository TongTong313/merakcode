import type { AppLocale } from "../../renderer/src/desktop/bridge-contract"

/**
 * When the local service fails to start, recognizes common causes in the error and returns an actionable hint.
 * Mostly Linux: the bundled Node needs libatomic and glibc 2.28 or newer; the deb package installs dependencies, the
 * AppImage does not.
 */
export namespace Diagnose {
  const RULES: { match: RegExp; zh: string; en: string }[] = [
    {
      match: /libatomic\.so/,
      zh: "缺少系统库 libatomic。Debian / Ubuntu 运行 sudo apt install libatomic1，Fedora 运行 sudo dnf install libatomic，装好后重新打开 MerakCode。",
      en: "The system library libatomic is missing. Run sudo apt install libatomic1 (Debian/Ubuntu) or sudo dnf install libatomic (Fedora), then reopen MerakCode.",
    },
    {
      match: /GLIBC_[\d.]+'? not found/,
      zh: "系统的 glibc 版本太旧：MerakCode 需要 glibc 2.28 及以上（Ubuntu 20.04、Debian 10、RHEL 8 或更新的系统）。",
      en: "Your system's glibc is too old: MerakCode needs glibc 2.28 or newer (Ubuntu 20.04, Debian 10, RHEL 8 or later).",
    },
  ]

  export function hint(error: string | undefined, locale: AppLocale) {
    if (!error) return
    return RULES.find((rule) => rule.match.test(error))?.[locale]
  }
}

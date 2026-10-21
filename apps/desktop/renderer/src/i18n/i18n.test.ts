import { describe, expect, test } from "vitest"
import { en } from "./en"
import { zh } from "./zh"
import { detect, fromConfig, setLocale, t } from "./index"

describe("界面文字", () => {
  test("中英文的键一一对应，没有空文字，变量名一致", () => {
    expect(Object.keys(en).toSorted()).toEqual(Object.keys(zh).toSorted())
    const vars = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).toSorted()
    for (const key of Object.keys(zh) as (keyof typeof zh)[]) {
      expect(zh[key].trim(), key).not.toBe("")
      expect(en[key].trim(), key).not.toBe("")
      expect(vars(en[key]), key).toEqual(vars(zh[key]))
    }
  })

  test("按系统语言选中文或英文；配置里的 zh-CN / en-US 对应过来", () => {
    expect(detect(["zh-TW", "en"])).toBe("zh")
    expect(detect(["en-GB", "zh-CN"])).toBe("zh")
    expect(detect(["fr-FR"])).toBe("en")
    expect(fromConfig("en-US")).toBe("en")
    expect(fromConfig("zh-CN")).toBe("zh")
    expect(fromConfig(undefined)).toBeUndefined()
  })

  test("小模型没选时的占位有中英文", () => {
    setLocale("zh")
    expect(t("settings.smallModel.auto")).toBe("按供应商自动选")
    setLocale("en")
    expect(t("settings.smallModel.auto")).toBe("Automatic per provider")
  })

  test("变量替换，切换语言后取对应的文字，html 的 lang 跟着变", () => {
    setLocale("zh")
    expect(t("review.hunk", { file: "a.ts", n: 2 })).toBe("a.ts 第 2 块")
    setLocale("en")
    expect(t("review.hunk", { file: "a.ts", n: 2 })).toBe("a.ts hunk 2")
    expect(document.documentElement.lang).toBe("en")
  })
})

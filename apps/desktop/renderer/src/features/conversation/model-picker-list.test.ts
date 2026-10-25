import { expect, test } from "vitest"
import { providerLabel } from "../../ui/provider-label"
import { pickerSections, type PickerEntry } from "./model-picker-list"

const titles = { configured: "配置的模型", official: "官方供应商" }

function entry(
  origin: "official" | "configured",
  id: string,
  name: string,
  modelID: string,
  homepage = true,
): PickerEntry {
  return {
    provider: { id, name, origin },
    model: { id: modelID, name: modelID, homepage },
    key: `${id}/${modelID}`,
  }
}

test("providers with the same name stay in their own section and the current model leads that section", () => {
  const sections = pickerSections(
    [
      entry("configured", "relay", "阿里云百炼", "custom"),
      entry("official", "alibaba-cn", "Alibaba (China)", "qwen-plus"),
      entry("official", "alibaba-cn", "Alibaba (China)", "qwen-max"),
    ],
    "alibaba-cn/qwen-max",
    titles,
  )
  expect(sections.map((section) => section.title)).toEqual(["配置的模型", "官方供应商"])
  expect(sections[0]?.items.map((item) => item.key)).toEqual(["relay/custom"])
  expect(sections[1]?.items.map((item) => item.key)).toEqual(["alibaba-cn/qwen-max", "alibaba-cn/qwen-plus"])
})

test("a model that is off the homepage stays out unless it is the current one", () => {
  const sections = pickerSections(
    [
      entry("official", "alibaba-cn", "Alibaba (China)", "qwen-plus"),
      entry("official", "alibaba-cn", "Alibaba (China)", "qwen-old", false),
      entry("official", "alibaba-cn", "Alibaba (China)", "qwen-max", false),
    ],
    "alibaba-cn/qwen-max",
    titles,
  )
  expect(sections.map((section) => section.title)).toEqual(["官方供应商"])
  expect(sections[0]?.items.map((item) => item.key)).toEqual(["alibaba-cn/qwen-max", "alibaba-cn/qwen-plus"])
})

test("the add list is the models that are off the homepage", () => {
  const sections = pickerSections(
    [
      entry("official", "alibaba-cn", "Alibaba (China)", "qwen-plus"),
      entry("official", "alibaba-cn", "Alibaba (China)", "qwen-plus-2025-12-01", false),
      entry("configured", "relay", "Relay", "custom", false),
    ],
    "relay/custom",
    titles,
    "",
    "extra",
  )
  expect(sections.map((section) => section.title)).toEqual(["官方供应商"])
  expect(sections[0]?.items.map((item) => item.key)).toEqual(["alibaba-cn/qwen-plus-2025-12-01"])
})

test("a section with no search hit is left out", () => {
  const sections = pickerSections(
    [entry("configured", "relay", "Relay", "custom"), entry("official", "openai", "OpenAI", "gpt-5.6-sol")],
    undefined,
    titles,
    "gpt",
  )
  expect(sections.map((section) => section.title)).toEqual(["官方供应商"])
})

test("the chinese name is used for an official provider and a configured provider keeps its own name", () => {
  expect(providerLabel({ id: "alibaba-cn", name: "Alibaba (China)", origin: "official" }, "zh")).toBe("阿里云百炼")
  expect(providerLabel({ id: "zhipuai", name: "Zhipu AI", origin: "official" }, "zh")).toBe("智谱")
  expect(providerLabel({ id: "moonshotai-cn", name: "Moonshot AI (China)", origin: "official" }, "zh")).toBe("月之暗面")
  expect(providerLabel({ id: "alibaba-cn", name: "Alibaba (China)", origin: "official" }, "en")).toBe("Alibaba (China)")
  expect(providerLabel({ id: "relay", name: "阿里云百炼", origin: "configured" }, "zh")).toBe("阿里云百炼")
})

import { render } from "solid-js/web"
import { afterEach, beforeEach, expect, test } from "vitest"
import { setLocale } from "../../i18n"
import { RoleTemplateSettings } from "./collaboration"

let cleanup = () => {}
beforeEach(() => setLocale("zh"))
afterEach(() => cleanup())

test("a built-in role is read-only and can be copied into a custom template", async () => {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const changes: unknown[] = []
  const dispose = render(
    () => (
      <RoleTemplateSettings
        templates={[
          {
            id: "builtin-developer",
            name: "开发工程师",
            role: "开发工程师",
            duty: "Implement and verify the assigned behavior.",
            builtin: true,
            editable: false,
          },
        ]}
        onChange={async (change) => {
          changes.push(change)
          return true
        }}
      />
    ),
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
  }
  expect(host.querySelector('[aria-label="编辑 开发工程师"]')).toBeNull()
  expect(host.querySelector('[aria-label="删除 开发工程师"]')).toBeNull()
  const copy = [...host.querySelectorAll("button")].find((button) => button.textContent === "复制为自定义")
  expect(copy).toBeDefined()
  copy!.click()
  const role = host.querySelector<HTMLInputElement>('[aria-label="角色"]')!
  expect(role.value).toBe("开发工程师")
  const save = [...host.querySelectorAll("button")].find((button) => button.textContent === "保存")!
  save.click()
  await Promise.resolve()
  expect(changes).toEqual([
    {
      type: "add",
      id: expect.stringMatching(/^custom-/),
      template: { name: "开发工程师", role: "开发工程师", duty: "Implement and verify the assigned behavior." },
    },
  ])
})

test("a custom role template can be edited", async () => {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const changes: unknown[] = []
  const dispose = render(
    () => (
      <RoleTemplateSettings
        templates={[
          { id: "custom-one", name: "自己的角色", role: "旧角色", duty: "Custom duty", builtin: false, editable: true },
        ]}
        onChange={async (change) => {
          changes.push(change)
          return true
        }}
      />
    ),
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
  }
  const edit = host.querySelector<HTMLButtonElement>('[aria-label="编辑 自己的角色"]')
  expect(edit).not.toBeNull()
  edit!.click()
  const role = host.querySelector<HTMLInputElement>('[aria-label="角色"]')!
  role.value = "新角色"
  role.dispatchEvent(new InputEvent("input", { bubbles: true }))
  ;[...host.querySelectorAll("button")].find((button) => button.textContent === "保存")!.click()
  await Promise.resolve()
  expect(changes).toEqual([
    { type: "update", id: "custom-one", template: { name: "自己的角色", role: "新角色", duty: "Custom duty" } },
  ])
})

test("a custom role template can be deleted", () => {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const changes: unknown[] = []
  const dispose = render(
    () => (
      <RoleTemplateSettings
        templates={[
          { id: "custom-delete", name: "临时角色", role: "测试", duty: "Test", builtin: false, editable: true },
        ]}
        onChange={async (change) => {
          changes.push(change)
          return true
        }}
      />
    ),
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
  }
  const remove = host.querySelector<HTMLButtonElement>('[aria-label="删除 临时角色"]')
  expect(remove).not.toBeNull()
  remove!.click()
  expect(changes).toEqual([{ type: "remove", id: "custom-delete" }])
})

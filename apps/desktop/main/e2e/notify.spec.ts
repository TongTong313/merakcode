import { test, expect, type Kit } from "./fixture"

// System notifications while the window is in the background: turn finished, approval needed, question asked.
// Real system notifications are not observable, so they are recorded at the browser Notification API.

/** Makes the window act as if in the background and records notifications; returns a reader for the records */
async function background(kit: Kit) {
  await kit.page.evaluate(() => {
    const sent: { title: string; body?: string }[] = []
    const record = window as unknown as { __sent: typeof sent; __click?: () => void }
    record.__sent = sent
    document.hasFocus = () => false
    class Fake {
      static permission = "granted"
      static requestPermission = async () => "granted"
      onclick: (() => void) | null = null
      constructor(title: string, options?: { body?: string }) {
        sent.push({ title, body: options?.body })
        record.__click = () => this.onclick?.()
      }
      close() {}
    }
    Object.defineProperty(window, "Notification", { value: Fake, configurable: true })
  })
  return () => kit.page.evaluate(() => (window as unknown as { __sent: { title: string; body?: string }[] }).__sent)
}

test("notifies in the background when a turn finishes; clicking returns to the conversation", async ({ kit }) => {
  const sent = await background(kit)
  await kit.send("在后台")
  await expect.poll(async () => (await sent()).map((item) => item.title)).toEqual(["对话完成"])
  // Navigate elsewhere first (in-app navigation, no page reload)
  const url = kit.page.url()
  await kit.page.getByRole("button", { name: "新对话" }).filter({ visible: true }).first().click()
  await expect.poll(() => kit.page.url()).not.toBe(url)
  await kit.page.evaluate(() => (window as unknown as { __click: () => void }).__click())
  await expect.poll(() => kit.page.url()).toBe(url)
})

test.describe("approval needed", () => {
  test.use({
    script: {
      reply: ({ toolResults }) =>
        toolResults.length
          ? { text: "DONE" }
          : { tool: "bash", args: { command: 'node -e "console.log(1)"', description: "run node" } },
    },
  })

  test("notifies when approval is needed while the window is in the background", async ({ kit }) => {
    const sent = await background(kit)
    await kit.send("跑个命令")
    await expect(kit.approval()).toBeVisible()
    await expect.poll(async () => (await sent()).map((item) => item.title)).toEqual(["需要你审批"])
  })
})

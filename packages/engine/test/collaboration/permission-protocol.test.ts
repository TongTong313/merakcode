import { SessionPlan } from "../../src/agent/session/plan"
import { PermissionNext } from "../../src/agent/permission/next"
import { PermissionPolicy } from "../../src/agent/permission/policy"
import { Bus } from "../../src/infra/bus"
import { Runtime } from "@merakcode/util/runtime"
import { expect, test } from "vitest"
import { inspectMember, runMember, runExternal } from "../../src/agent/external/runtime"
import { tmpdir, selectPermissionLevel } from "../fixture/fixture"
import { Instance } from "../../src/infra/project/instance"
import { Session } from "../../src/agent/session"
import fs from "node:fs/promises"
import path from "node:path"

const legacy = `
const readline = require("node:readline")
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line)
  if (process.argv[1]) require("node:fs").appendFileSync(process.argv[1], request.method + "\\n")
  if (request.id === undefined) return
  const result = request.method === "initialize" ? { protocol: 2, name: "Legacy" } : { text: "TASK RAN" }
  process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n")
})

`

test.each(["ask", "autoApprove", "fullTakeover"] as const)(
  "an opaque adapter supports only the actual %s contract",
  async (permissionLevel) => {
    await using tmp = await tmpdir()
    const marker = path.join(tmp.path, "effect")
    const script = `const fs=require("node:fs"),readline=require("node:readline")
readline.createInterface({input:process.stdin}).on("line",line=>{
 const q=JSON.parse(line);if(q.id===undefined)return
 if(q.method==="task/run")fs.writeFileSync(process.argv[1],"RAN")
 const result=q.method==="initialize"?{protocol:3,name:"Opaque fixture",capabilities:{modelSelection:false,modelDiscovery:false,textStreaming:false,resume:false,permission:"external",questions:false}}:{text:"DONE"}
 process.stdout.write(JSON.stringify({id:q.id,result})+"\\n")
})`
    const running = runMember({
      launch: [process.execPath, "-e", script, marker],
      product: { id: "opaque", title: "Opaque" },
      task: { prompt: "Controlled task", cwd: tmp.path, permissionLevel },
      abort: new AbortController().signal,
      host: {
        step: () => {},
        permission: async () => ({ allow: false, message: "No callback" }),
        question: async () => [],
      },
    })
    if (permissionLevel === "fullTakeover") {
      await running
      expect(await fs.readFile(marker, "utf8")).toBe("RAN")
      return
    }
    await expect(running).rejects.toMatchObject({ name: "ExternalAdapterError" })
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" })
  },
)

test.each(["inspect", "run"] as const)("%s rejects protocol 2 before accepting a task", async (kind) => {
  await using tmp = await tmpdir()
  const input = { launch: [process.execPath, "-e", legacy], product: { id: "legacy", title: "Legacy" }, cwd: tmp.path }
  const running =
    kind === "inspect"
      ? inspectMember(input)
      : runMember({
          ...input,
          task: { prompt: "Do not start with the old protocol", cwd: tmp.path, permissionLevel: "ask" },
          abort: new AbortController().signal,
          host: {
            step: () => {},
            permission: async () => ({ allow: false, message: "Tools disabled" }),
            question: async () => [],
          },
        })
  await expect(running).rejects.toThrow(/protocol|upgrade|协议|升级/)
})

test("a persisted task sends no task messages before protocol verification", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const file = path.join(tmp.path, "received")
      await expect(
        runExternal({
          runID: "protocol-order",
          sessionID: session.id,
          launch: [process.execPath, "-e", legacy, file],
          product: { id: "legacy", title: "Legacy" },
          task: { prompt: "Do not start", cwd: tmp.path, permissionLevel: "ask" },
          abort: new AbortController().signal,
          host: {
            step: () => {},
            permission: async () => ({ allow: false, message: "No tools" }),
            question: async () => [],
          },
        }),
      ).rejects.toThrow(/protocol|upgrade|协议|升级/)
      expect((await fs.readFile(file, "utf8")).trim().split("\n")).toEqual(["initialize"])
    },
  })
})

test("tightening a running opaque task waits for its real process to stop", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await selectPermissionLevel({ sessionID: session.id, permissionLevel: "fullTakeover" })
      const marker = path.join(tmp.path, "child")
      const script = `const fs=require("node:fs"),cp=require("node:child_process"),readline=require("node:readline")
let child,task;const io=readline.createInterface({input:process.stdin});const send=(id,result)=>process.stdout.write(JSON.stringify({id,result})+"\\n")
io.on("line",line=>{const q=JSON.parse(line)
 if(q.method==="initialize")return send(q.id,{protocol:3,name:"Opaque process",capabilities:{modelSelection:false,modelDiscovery:false,textStreaming:false,resume:false,permission:"external",questions:false}})
 if(q.method==="task/cancel")return child?.kill()
 if(q.method!=="task/run")return
 task=q.id;child=cp.spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true})
 child.once("spawn",()=>fs.writeFileSync(process.argv[1],String(child.pid)))
 child.once("close",()=>{fs.writeFileSync(process.argv[1]+".stopped","stopped");send(task,{text:"DONE"})})
});io.on("close",()=>child?.kill())`
      const controller = new AbortController()
      let settled = false
      const running = runExternal({
        runID: "opaque-process",
        sessionID: session.id,
        launch: [process.execPath, "-e", script, marker],
        product: { id: "opaque", title: "Opaque" },
        task: { prompt: "Run until cancelled", cwd: tmp.path, permissionLevel: "fullTakeover" },
        abort: controller.signal,
        host: {
          step: () => {},
          permission: async () => ({ allow: false, message: "No callback" }),
          question: async () => [],
        },
      }).finally(() => {
        settled = true
      })
      running.catch(() => {})
      try {
        await expect.poll(() => fs.readFile(marker, "utf8").catch(() => ""), { timeout: 5000 }).not.toBe("")
        await selectPermissionLevel({ sessionID: session.id, permissionLevel: "ask" })
        await expect.poll(() => settled, { timeout: 2000 }).toBe(true)
        expect(await fs.readFile(marker + ".stopped", "utf8")).toBe("stopped")
      } finally {
        controller.abort()
        await running.catch(() => {})
      }
    },
  })
}, 15000)

test.each(["operation/start", "permission/request"])(
  "%s cannot authorize effects before task dispatch",
  async (method) => {
    await using tmp = await tmpdir()
    const marker = path.join(tmp.path, "early-effect")
    const script = `const fs=require("node:fs"),readline=require("node:readline")
const send=v=>process.stdout.write(JSON.stringify(v)+"\\n")
readline.createInterface({input:process.stdin}).on("line",line=>{const q=JSON.parse(line)
 if(q.id==="early"){if(q.result?.allow)fs.writeFileSync(process.argv[1],"CHANGED");fs.writeFileSync(process.argv[1]+".checked","CHECKED");return}
 if(q.method==="initialize"){send({id:q.id,result:{protocol:3,name:"Early action fixture"}});send({id:"early",method:process.argv[2],params:process.argv[2]==="operation/start"?{id:"early-write",request:{kind:"write",paths:["early-effect"]},isolation:"none"}:{request:{kind:"write",paths:["early-effect"]}}});return}
 if(q.method==="task/run")send({id:q.id,result:{text:"DONE"}})
})`
    let dispatched = false
    const running = runMember({
      launch: [process.execPath, "-e", script, marker, method],
      product: { id: "early", title: "Early fixture" },
      task: { prompt: "Do not start before checks", cwd: tmp.path, permissionLevel: "fullTakeover" },
      abort: new AbortController().signal,
      beforeTask: async () => {
        await expect
          .poll(
            () =>
              fs.access(marker + ".checked").then(
                () => true,
                () => false,
              ),
            { timeout: 5000 },
          )
          .toBe(true)
        await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" })
        dispatched = true
      },
      host: { step: () => {}, permission: async () => ({ allow: true }), question: async () => [] },
    })
    await running
    expect(dispatched).toBe(true)
  },
)

test("plan dispatch repeats consent checks when the root changes during final checks", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await selectPermissionLevel({ sessionID: session.id, permissionLevel: "fullTakeover" })
      await SessionPlan.save({
        sessionID: session.id,
        source: "human",
        content: "# Fixed controlled plan",
        expectedRevision: 0,
      })
      const plan = await SessionPlan.start(session.id)
      const received = path.join(tmp.path, "received-task")
      const requests: PermissionNext.Request[] = []
      const off = Bus.subscribe(PermissionNext.Event.Asked, (event) => {
        requests.push(event.properties)
      })
      const controller = new AbortController()
      let first = true
      const running = runExternal({
        runID: "final-plan-consent",
        sessionID: session.id,
        launch: [
          process.execPath,
          ...Runtime.execArgv(),
          path.join(import.meta.dirname, "../server/fixture/external-adapter.ts"),
          "plan-input",
          received,
        ],
        product: { id: "guarded", title: "Controlled adapter" },
        task: {
          prompt: "Run the fixed plan",
          cwd: tmp.path,
          permissionLevel: "fullTakeover",
          plan: SessionPlan.inputForTask(plan),
        },
        abort: controller.signal,
        beforeTask: async () => {
          await PermissionNext.askCurrent(
            {
              sessionID: session.id,
              permission: "subagent",
              checks: [PermissionPolicy.subagent("guarded")],
              metadata: { unsandboxed: true },
            },
            async () => PermissionPolicy.ruleset((await Session.get(session.id)).permissionLevel!),
          )
          if (first) {
            first = false
            await selectPermissionLevel({ sessionID: session.id, permissionLevel: "ask" })
          }
        },
        host: {
          step() {},
          permission: async () => ({ allow: false, message: "No operations" }),
          question: async () => [],
        },
      })
      running.catch(() => {})
      const exists = () =>
        fs.access(received).then(
          () => true,
          () => false,
        )
      try {
        await expect.poll(async () => requests.length > 0 || (await exists())).toBe(true)
        expect(await exists()).toBe(false)
        expect(requests).toHaveLength(1)
        await PermissionNext.reply({ requestID: requests[0]!.id, reply: "once" })
        await running
        expect(JSON.parse(await fs.readFile(received, "utf8")).permissionLevel).toBe("ask")
      } finally {
        off()
        controller.abort()
        await PermissionNext.abortPending(session.id)
        await running.catch(() => {})
      }
    },
  })
}, 20000)

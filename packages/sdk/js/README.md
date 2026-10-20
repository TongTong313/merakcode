# @merakcode/sdk

Use [MerakCode](https://github.com/TongTong313/merakcode), the open-source AI coding agent, from your own program: open sessions, send messages, stream the replies, handle approvals, and give the model your own tools.

在自己的程序里使用开源 AI 编程助手 [MerakCode](https://github.com/TongTong313/merakcode)：开会话、发消息、边生成边拿回复、处理审批，还能把自己的函数交给模型调用。

```sh
npm install @merakcode/sdk
```

Needs Node.js 24 or newer. npm also installs the engine for your system. · 需要 Node.js 24 以上，npm 会一起装上本机对应的引擎。

```ts
import { createMerakCode } from "@merakcode/sdk"

const merak = await createMerakCode({ cwd: process.cwd() })
const session = await merak.session()
for await (const event of session.run("What does this project do?")) {
  if (event.type === "text") process.stdout.write(event.delta)
}
await merak.close()
```

- Guide: [English](https://github.com/TongTong313/merakcode/blob/main/docs/sdk/README.en.md) · 手册：[简体中文](https://github.com/TongTong313/merakcode/blob/main/docs/sdk/README.md)
- [API reference · 接口参考](https://github.com/TongTong313/merakcode/blob/main/docs/sdk/reference.md)
- [Examples · 示例](https://github.com/TongTong313/merakcode/tree/main/packages/sdk/js/examples)
- [Error codes · 错误码](https://github.com/TongTong313/merakcode/blob/main/docs/errors.md)

MIT

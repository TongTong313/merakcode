import { Server } from "../server/server"

/** The engine's OpenAPI document, with a short code sample per operation (used to generate the SDK) */
export async function openapi() {
  const specs = await Server.openapi()
  for (const item of Object.values(specs.paths)) {
    for (const method of ["get", "post", "put", "delete", "patch"] as const) {
      const operation = item[method]
      if (!operation?.operationId) continue
      // @ts-expect-error vendor extension
      operation["x-codeSamples"] = [
        {
          lang: "js",
          source: [
            `import { createMerakCodeClient } from "@merakcode/sdk`,
            ``,
            `const client = createMerakCodeClient()`,
            `await client.${operation.operationId}({`,
            `  ...`,
            `})`,
          ].join("\n"),
        },
      ]
    }
  }
  return specs
}

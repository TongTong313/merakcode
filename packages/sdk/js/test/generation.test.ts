import { expect, test } from "vitest"
import { canonical } from "../script/generated"

test("schema registration and union order do not change generated input", () => {
  const a = { components: { schemas: { B: { oneOf: [{ $ref: "#/A" }, { type: "string" }] }, A: { type: "number" } } } }
  const b = { components: { schemas: { A: { type: "number" }, B: { oneOf: [{ type: "string" }, { $ref: "#/A" }] } } } }
  expect(JSON.stringify(canonical(a))).toBe(JSON.stringify(canonical(b)))
  expect(canonical({ required: ["b", "a"] })).toEqual({ required: ["a", "b"] })
})

test("schema normalization preserves ordered user values and tuple positions", () => {
  const value = {
    default: { enum: ["b", "a"] },
    example: { oneOf: [2, 1] },
    examples: [{ required: ["b", "a"] }],
    const: { enum: [2, 1] },
    prefixItems: [{ type: "string" }, { type: "number" }],
  }
  expect(canonical(value)).toEqual(value)
})

test("enum members preserve literal arrays even when their keys look like schema keywords", () => {
  const value = { enum: [{ required: ["b", "a"], oneOf: [2, 1], nested: { enum: ["z", "a"] } }] }
  expect(canonical(value)).toEqual(value)
})

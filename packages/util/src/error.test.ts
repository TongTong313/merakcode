import { test, expect } from "vitest"
import {
  errorCode,
  isMessageAbortedError,
  localizeError,
  localizeToast,
  NamedError,
  readableErrorText,
  unwrapErrorText,
} from "./error"
import z from "zod"

test("errorCode reads the code an error carries, or looks it up by name", () => {
  expect(errorCode({ name: "NotFoundError", code: "MRK-1011", data: {} })).toBe("MRK-1011")
  expect(errorCode({ name: "ProviderModelNotFoundError", data: {} })).toBe("MRK-2002")
  expect(errorCode({ name: "APIError", data: { statusCode: 429 } })).toBe("MRK-2004")
  expect(errorCode(Object.assign(new Error("x"), { code: "MRK-1007" }))).toBe("MRK-1007")
  expect(errorCode(Object.assign(new Error("x"), { code: "ENOENT" }))).toBeUndefined()
  expect(errorCode("boom")).toBeUndefined()
  expect(errorCode(undefined)).toBeUndefined()
})

test("NamedError carries its catalog code in toObject() and its schema", () => {
  const JsonError = NamedError.create("ConfigJsonError", z.object({ path: z.string() }))
  const object = new JsonError({ path: "/a.json" }).toObject()
  expect(object).toEqual({ name: "ConfigJsonError", code: "MRK-3001", data: { path: "/a.json" } })
  expect(JsonError.Schema.parse(object)).toEqual(object)
})

test("provider API errors get their code from the HTTP status", () => {
  const APIError = NamedError.create("APIError", z.object({ message: z.string(), statusCode: z.number().optional() }))
  expect(new APIError({ message: "slow down", statusCode: 429 }).toObject().code).toBe("MRK-2004")
})

test("isMessageAbortedError: true for MessageAbortedError", () => {
  expect(isMessageAbortedError({ name: "MessageAbortedError" })).toBe(true)
})

test("isMessageAbortedError: false for null", () => {
  expect(isMessageAbortedError(null)).toBe(false)
})

test("unwrapErrorText: extracts errorMessage from gateway JSON", () => {
  expect(unwrapErrorText('{"errorCode":"FORBIDDEN","errorMessage":"api key invalid","state":"Error"}')).toBe(
    "api key invalid",
  )
  expect(unwrapErrorText('{"error":{"type":"RateLimit","message":"too many"}}')).toBe("RateLimit: too many")
})

test("readableErrorText: handles a retry { message } wrapper and a top-level gateway object", () => {
  expect(readableErrorText({ message: "Unable to connect" })).toBe("Unable to connect")
  expect(readableErrorText({ errorCode: "FORBIDDEN", errorMessage: "api key invalid", state: "Error" })).toBe(
    "api key invalid",
  )
  expect(readableErrorText({})).toBe("")
  expect(readableErrorText({})).not.toBe("[object Object]")
})

test("localizeError: with code and params", () => {
  const t = (key: string, params?: Record<string, any>) => {
    if (key === "error.modelNotFound") {
      return `未找到模型: ${params?.provider}/${params?.model}${params?.hint}`
    }
    return key
  }

  const error = {
    name: "ModelNotFoundError",
    data: {
      providerID: "openai",
      modelID: "gpt-4",
      messageKey: "error.modelNotFound",
      params: { provider: "openai", model: "gpt-4", hint: ", did you mean: gpt-4o?" },
      message: "Model not found: openai/gpt-4, did you mean: gpt-4o?",
    },
  }

  const result = localizeError(error, t)
  expect(result).toBe("未找到模型: openai/gpt-4, did you mean: gpt-4o?")
})

test("localizeError: without code, fallback to message", () => {
  const t = () => "translated"

  const error = {
    name: "UnknownError",
    data: {
      message: "Original error message",
    },
  }

  const result = localizeError(error, t)
  expect(result).toBe("Original error message")
})

test("localizeError: translation error, fallback to message", () => {
  const t = () => {
    throw new Error("Translation failed")
  }

  const error = {
    name: "ModelNotFoundError",
    data: {
      messageKey: "error.modelNotFound",
      params: { provider: "openai", model: "gpt-4" },
      message: "Model not found: openai/gpt-4",
    },
  }

  const result = localizeError(error, t)
  expect(result).toBe("Model not found: openai/gpt-4")
})

test("localizeError: invalid error object", () => {
  const t = () => "translated"

  expect(localizeError(null, t)).toBe("null")
  expect(localizeError(undefined, t)).toBe("undefined")
  expect(localizeError("string error", t)).toBe("string error")
  expect(localizeError(123, t)).toBe("123")
})

test("localizeError: a retry { message } wrapper does not return [object Object]", () => {
  const t = () => "translated"
  expect(localizeError({ message: "Unable to connect" }, t)).toBe("Unable to connect")
  expect(localizeError({ message: "Unable to connect" }, t)).not.toBe("[object Object]")
})

test("localizeError: extracts errorMessage when data.message is a gateway object", () => {
  const t = () => "translated"
  expect(
    localizeError(
      {
        name: "APIError",
        data: { message: { errorCode: "FORBIDDEN", errorMessage: "api key invalid", state: "Error" } },
      },
      t,
    ),
  ).toBe("api key invalid")
})

test("localizeError: extracts errorMessage when data.message is a gateway JSON string", () => {
  const t = () => "translated"
  expect(
    localizeError(
      {
        name: "APIError",
        data: { message: '{"errorCode":"FORBIDDEN","errorMessage":"api key invalid","state":"Error"}' },
      },
      t,
    ),
  ).toBe("api key invalid")
})

test("localizeError: key not found (t returns key itself), fallback to message", () => {
  // like the i18n module, returns the key itself when it is missing
  const t = (key: string) => key

  const error = {
    name: "ModelNotFoundError",
    data: {
      messageKey: "error.modelNotFound",
      params: { provider: "openai", model: "gpt-4" },
      message: "Model not found: openai/gpt-4",
    },
  }

  const result = localizeError(error, t)
  expect(result).toBe("Model not found: openai/gpt-4")
})

test("localizeToast: with titleCode and messageCode", () => {
  const t = (key: string, params?: Record<string, any>) => {
    if (key === "toast.title") return "标题"
    if (key === "toast.message") return `消息: ${params?.key}`
    return key
  }

  const toast = {
    title: "Original Title",
    message: "Original Message",
    titleCode: "toast.title",
    messageCode: "toast.message",
    params: { key: "value" },
  }

  const result = localizeToast(toast, t)
  expect(result.title).toBe("标题")
  expect(result.message).toBe("消息: value")
})

test("localizeToast: without codes, use original", () => {
  const t = () => "translated"

  const toast = {
    title: "Original Title",
    message: "Original Message",
  }

  const result = localizeToast(toast, t)
  expect(result.title).toBe("Original Title")
  expect(result.message).toBe("Original Message")
})

test("localizeToast: translation error, fallback to original", () => {
  const t = () => {
    throw new Error("Translation failed")
  }

  const toast = {
    title: "Original Title",
    message: "Original Message",
    titleCode: "toast.title",
    messageCode: "toast.message",
  }

  const result = localizeToast(toast, t)
  expect(result.title).toBe("Original Title")
  expect(result.message).toBe("Original Message")
})

test("localizeToast: missing title", () => {
  const t = () => "translated"

  const toast = {
    message: "Original Message",
  }

  const result = localizeToast(toast, t)
  expect(result.title).toBe("")
  expect(result.message).toBe("Original Message")
})

test("localizeError: with suggestions, uses .withSuggestions key when available", () => {
  const t = (key: string, params?: Record<string, any>) => {
    if (key === "error.modelNotFound.withSuggestions") {
      return `未找到模型：${params?.provider}/${params?.model}，你是不是想输入：${params?.suggestions}？`
    }
    if (key === "error.modelNotFound") {
      return `未找到模型：${params?.provider}/${params?.model}`
    }
    return key
  }

  const error = {
    name: "ModelNotFoundError",
    data: {
      messageKey: "error.modelNotFound",
      params: { provider: "openai", model: "gpt-4", suggestions: "gpt-4o, gpt-4-turbo" },
      message: "Model not found: openai/gpt-4",
    },
  }

  const result = localizeError(error, t)
  expect(result).toBe("未找到模型：openai/gpt-4，你是不是想输入：gpt-4o, gpt-4-turbo？")
})

test("localizeError: with suggestions, .withSuggestions key not found, fallback to base code", () => {
  const t = (key: string, params?: Record<string, any>) => {
    if (key === "error.modelNotFound") {
      return `未找到模型：${params?.provider}/${params?.model}`
    }
    return key
  }

  const error = {
    name: "ModelNotFoundError",
    data: {
      messageKey: "error.modelNotFound",
      params: { provider: "openai", model: "gpt-4", suggestions: "gpt-4o" },
      message: "Model not found: openai/gpt-4",
    },
  }

  const result = localizeError(error, t)
  expect(result).toBe("未找到模型：openai/gpt-4")
})

test("localizeError: with available, uses .withAvailable key when available", () => {
  const t = (key: string, params?: Record<string, any>) => {
    if (key === "error.agentNotFound2.withAvailable") {
      return `未找到智能体：\"${params?.agent}\"，可用智能体：${params?.available}`
    }
    if (key === "error.agentNotFound2") {
      return `未找到智能体：\"${params?.agent}\"`
    }
    return key
  }

  const error = {
    name: "AgentNotFoundError",
    data: {
      messageKey: "error.agentNotFound2",
      params: { agent: "unknown", available: "coder, reviewer" },
      message: 'Agent not found: "unknown"',
    },
  }

  const result = localizeError(error, t)
  expect(result).toBe('未找到智能体："unknown"，可用智能体：coder, reviewer')
})

test("localizeError: with available, .withAvailable key not found, fallback to base code", () => {
  const t = (key: string, params?: Record<string, any>) => {
    if (key === "error.agentNotFound2") {
      return `未找到智能体：\"${params?.agent}\"`
    }
    return key
  }

  const error = {
    name: "AgentNotFoundError",
    data: {
      messageKey: "error.agentNotFound2",
      params: { agent: "unknown", available: "coder, reviewer" },
      message: 'Agent not found: "unknown"',
    },
  }

  const result = localizeError(error, t)
  expect(result).toBe('未找到智能体："unknown"')
})

test("localizeError: without suggestions/available, uses base code directly", () => {
  const t = (key: string, params?: Record<string, any>) => {
    if (key === "error.modelNotFound") {
      return `未找到模型：${params?.provider}/${params?.model}`
    }
    return key
  }

  const error = {
    name: "ModelNotFoundError",
    data: {
      messageKey: "error.modelNotFound",
      params: { provider: "openai", model: "gpt-4" },
      message: "Model not found: openai/gpt-4",
    },
  }

  const result = localizeError(error, t)
  expect(result).toBe("未找到模型：openai/gpt-4")
})

test("NamedError.isInstance: recognizes plain objects by name; rejects null and non-objects", () => {
  const Failed = NamedError.create("SomethingFailed", z.object({ name: z.string() }))
  expect(Failed.isInstance(new Failed({ name: "a" }))).toBe(true)
  expect(Failed.isInstance({ name: "SomethingFailed", data: { name: "a" } })).toBe(true)
  expect(Failed.isInstance(null)).toBe(false)
  expect(Failed.isInstance("SomethingFailed")).toBe(false)
})

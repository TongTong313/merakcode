import { test, expect } from "vitest"
import { Question } from "@merakcode/engine/agent/session/question/index"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Bus } from "@merakcode/engine/infra/bus/index"
import { tmpdir } from "../fixture/fixture"

test("ask - returns pending promise", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const promise = Question.ask({
        sessionID: "ses_test",
        questions: [
          {
            question: "What would you like to do?",
            header: "Action",
            options: [
              { label: "Option 1", description: "First option" },
              { label: "Option 2", description: "Second option" },
            ],
          },
        ],
      })
      expect(promise).toBeInstanceOf(Promise)
    },
  })
})

test("ask - adds to pending list", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const questions = [
        {
          question: "What would you like to do?",
          header: "Action",
          options: [
            { label: "Option 1", description: "First option" },
            { label: "Option 2", description: "Second option" },
          ],
        },
      ]

      Question.ask({
        sessionID: "ses_test",
        questions,
      })

      const pending = await Question.list()
      expect(pending.length).toBe(1)
      expect(pending[0].questions).toEqual(questions)
    },
  })
})

// reply tests

test("reply - resolves the pending ask with answers", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const questions = [
        {
          question: "What would you like to do?",
          header: "Action",
          options: [
            { label: "Option 1", description: "First option" },
            { label: "Option 2", description: "Second option" },
          ],
        },
      ]

      const askPromise = Question.ask({
        sessionID: "ses_test",
        questions,
      })

      const pending = await Question.list()
      const requestID = pending[0].id

      await Question.reply({
        requestID,
        answers: [["Option 1"]],
      })

      const answers = await askPromise
      expect(answers).toEqual([["Option 1"]])
    },
  })
})

test("reply - removes from pending list", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      Question.ask({
        sessionID: "ses_test",
        questions: [
          {
            question: "What would you like to do?",
            header: "Action",
            options: [
              { label: "Option 1", description: "First option" },
              { label: "Option 2", description: "Second option" },
            ],
          },
        ],
      })

      const pending = await Question.list()
      expect(pending.length).toBe(1)

      await Question.reply({
        requestID: pending[0].id,
        answers: [["Option 1"]],
      })

      const pendingAfter = await Question.list()
      expect(pendingAfter.length).toBe(0)
    },
  })
})

test("reply - does nothing for unknown requestID", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Question.reply({
        requestID: "que_unknown",
        answers: [["Option 1"]],
      })
      // Should not throw
    },
  })
})

// reject tests

test("reject - throws RejectedError", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const askPromise = Question.ask({
        sessionID: "ses_test",
        questions: [
          {
            question: "What would you like to do?",
            header: "Action",
            options: [
              { label: "Option 1", description: "First option" },
              { label: "Option 2", description: "Second option" },
            ],
          },
        ],
      })

      const pending = await Question.list()
      await Question.reject(pending[0].id)

      await expect(askPromise).rejects.toBeInstanceOf(Question.RejectedError)
    },
  })
})

test("reject - removes from pending list", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const askPromise = Question.ask({
        sessionID: "ses_test",
        questions: [
          {
            question: "What would you like to do?",
            header: "Action",
            options: [
              { label: "Option 1", description: "First option" },
              { label: "Option 2", description: "Second option" },
            ],
          },
        ],
      })

      const pending = await Question.list()
      expect(pending.length).toBe(1)

      await Question.reject(pending[0].id)
      askPromise.catch(() => {}) // Ignore rejection

      const pendingAfter = await Question.list()
      expect(pendingAfter.length).toBe(0)
    },
  })
})

test("dismiss:false rejects ordinary dismissal but accepts its explicit Skip option", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const askPromise = Question.ask({
        sessionID: "ses_required",
        questions: [
          {
            question: "Switch modes?",
            header: "Mode",
            dismiss: false,
            custom: false,
            options: [
              { label: "Yes", description: "Switch" },
              { label: "Skip", description: "Stay here" },
            ],
          },
        ],
      })
      const [pending] = await Question.list()
      const rejected: string[] = []
      const unsubscribe = Bus.subscribe(Question.Event.Rejected, (event) => rejected.push(event.properties.requestID))
      try {
        await expect(Question.reject(pending.id)).rejects.toBeInstanceOf(Question.NotDismissibleError)
        expect((await Question.list()).map((item) => item.id)).toEqual([pending.id])
        expect(rejected).toEqual([])
        expect(await Question.reply({ requestID: pending.id, answers: [["Skip"]] })).toBe(true)
        expect(await askPromise).toEqual([["Skip"]])
      } finally {
        unsubscribe()
      }
    },
  })
})

test("dismiss:false keeps pending after empty, missing, forged, or multiple answers", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const askPromise = Question.ask({
        sessionID: "ses_required_reply",
        questions: [
          {
            question: "Switch modes?",
            header: "Mode",
            dismiss: false,
            custom: false,
            options: [
              { label: "Yes", description: "Switch" },
              { label: "Skip", description: "Stay" },
            ],
          },
        ],
      })
      const [pending] = await Question.list()
      for (const answers of [[], [[]], [[" "]], [["forged"]], [["Yes", "Skip"]]]) {
        await expect(Question.reply({ requestID: pending.id, answers })).rejects.toBeInstanceOf(
          Question.InvalidReplyError,
        )
        expect((await Question.list()).map((item) => item.id)).toEqual([pending.id])
      }
      await Question.reply({ requestID: pending.id, answers: [["Yes"]] })
      expect(await askPromise).toEqual([["Yes"]])
    },
  })
})

test("dismiss:false still allows internal timeout and session cancellation", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const question = {
        question: "Continue?",
        header: "Continue",
        dismiss: false,
        options: [{ label: "Yes", description: "Continue" }],
      }
      const timed = Question.ask({ sessionID: "ses_timeout_required", questions: [question], timeoutMs: 10 })
      expect(await timed).toEqual([[]])
      const cancelled = Question.ask({ sessionID: "ses_abort_required", questions: [question] })
      const cancelledResult = cancelled.catch((error) => error)
      await Question.abortPending("ses_abort_required")
      expect(await cancelledResult).toBeInstanceOf(Question.AbortedError)
      expect(await Question.list()).toEqual([])
    },
  })
})

test("abortPending - stopping a session rejects its pending questions and emits question.rejected", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const askPromise = Question.ask({
        sessionID: "ses_abort",
        questions: [
          {
            question: "继续吗？",
            header: "继续",
            options: [{ label: "是", description: "继续" }],
          },
        ],
      })
      const other = Question.ask({
        sessionID: "ses_keep",
        questions: [
          {
            question: "留下？",
            header: "留下",
            options: [{ label: "是", description: "留下" }],
          },
        ],
      })

      const rejected = Promise.withResolvers<string>()
      const unsub = Bus.subscribe(Question.Event.Rejected, (event) => {
        rejected.resolve(event.properties.requestID)
      })

      const pending = await Question.list()
      const abortID = pending.find((item) => item.sessionID === "ses_abort")?.id
      if (!abortID) throw new Error("expected pending question for ses_abort")

      await Question.abortPending("ses_abort")
      expect(await rejected.promise).toBe(abortID)
      unsub()

      await expect(askPromise).rejects.toBeInstanceOf(Question.AbortedError)
      const left = await Question.list()
      expect(left).toHaveLength(1)
      expect(left[0].sessionID).toBe("ses_keep")

      await Question.reply({ requestID: left[0].id, answers: [["是"]] })
      await other
    },
  })
})

test("reject - does nothing for unknown requestID", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Question.reject("que_unknown")
      // Should not throw
    },
  })
})

// multiple questions tests

test("ask - handles multiple questions", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const questions = [
        {
          question: "What would you like to do?",
          header: "Action",
          options: [
            { label: "Build", description: "Build the project" },
            { label: "Test", description: "Run tests" },
          ],
        },
        {
          question: "Which environment?",
          header: "Env",
          options: [
            { label: "Dev", description: "Development" },
            { label: "Prod", description: "Production" },
          ],
        },
      ]

      const askPromise = Question.ask({
        sessionID: "ses_test",
        questions,
      })

      const pending = await Question.list()

      await Question.reply({
        requestID: pending[0].id,
        answers: [["Build"], ["Dev"]],
      })

      const answers = await askPromise
      expect(answers).toEqual([["Build"], ["Dev"]])
    },
  })
})

test("ask - timeout resolves empty answers per question", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const p = Question.ask({
        sessionID: "ses_timeout",
        questions: [
          {
            question: "One?",
            header: "A",
            options: [{ label: "x", description: "d" }],
          },
          {
            question: "Two?",
            header: "B",
            options: [{ label: "y", description: "d" }],
          },
        ],
        timeoutMs: 200,
      })
      const answers = await p
      expect(answers).toEqual([[], []])
      expect((await Question.list()).length).toBe(0)
    },
  })
})

test("ask - reply before timeout clears timer", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const p = Question.ask({
        sessionID: "ses_timeout2",
        questions: [
          {
            question: "Pick",
            header: "H",
            options: [{ label: "A", description: "d" }],
          },
        ],
        timeoutMs: 60_000,
      })
      const pending = await Question.list()
      expect(pending[0].expiresAt).toBeGreaterThan(Date.now())
      await Question.reply({ requestID: pending[0].id, answers: [["A"]] })
      expect(await p).toEqual([["A"]])
    },
  })
})

test("ask - abort rejects with AbortedError and clears pending", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const controller = new AbortController()
      const p = Question.ask({
        sessionID: "ses_abort",
        questions: [{ question: "Q", header: "H", options: [{ label: "A", description: "d" }] }],
        abort: controller.signal,
      })
      expect((await Question.list()).length).toBe(1)
      controller.abort()
      await expect(p).rejects.toBeInstanceOf(Question.AbortedError)
      expect((await Question.list()).length).toBe(0)
    },
  })
})

test("ask - already aborted signal rejects immediately", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const controller = new AbortController()
      controller.abort()
      const p = Question.ask({
        sessionID: "ses_abort2",
        questions: [{ question: "Q", header: "H", options: [{ label: "A", description: "d" }] }],
        abort: controller.signal,
      })
      await expect(p).rejects.toBeInstanceOf(Question.AbortedError)
      expect((await Question.list()).length).toBe(0)
    },
  })
})

// list tests

test("list - returns all pending requests", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      Question.ask({
        sessionID: "ses_test1",
        questions: [
          {
            question: "Question 1?",
            header: "Q1",
            options: [{ label: "A", description: "A" }],
          },
        ],
      })

      Question.ask({
        sessionID: "ses_test2",
        questions: [
          {
            question: "Question 2?",
            header: "Q2",
            options: [{ label: "B", description: "B" }],
          },
        ],
      })

      const pending = await Question.list()
      expect(pending.length).toBe(2)
    },
  })
})

test("list - returns empty when no pending", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const pending = await Question.list()
      expect(pending.length).toBe(0)
    },
  })
})

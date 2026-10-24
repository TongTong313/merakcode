import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { z } from "zod"
import { validator } from "../validator"
import { lazy } from "../../util/lazy"
import { Instance } from "../../project/instance"
import { Session } from "../../session"
import { GroupError, createGroup } from "../../collaboration/board"
import { Text } from "../../util/text"
import { porcelain } from "../../collaboration/artifacts"
import { BUILTIN_PRODUCTS, configuredProducts, probe, productSources } from "../../collaboration/run"
import { all, create, join, leave, load, update } from "../../collaboration/store"
import { ProductChange, changeProduct } from "../../collaboration/product-config"

const Seat = z
  .object({
    id: z.string(),
    name: z.string(),
    role: z.string(),
    duty: z.string(),
    product: z.string(),
    leader: z.boolean(),
    privateSessionID: z.string().optional(),
  })
  .meta({ ref: "CollaborationSeat" })

const Result = z
  .object({
    seatID: z.string(),
    name: z.string(),
    text: z.string(),
    requestID: z.string(),
    at: z.number(),
  })
  .meta({ ref: "CollaborationResult" })

const Event = z
  .object({
    at: z.number(),
    kind: z.enum(["join", "leave", "rename"]),
    names: z.string().array(),
  })
  .meta({ ref: "CollaborationEvent" })

const Group = z
  .object({
    seats: Seat.array(),
    events: Event.array(),
    results: Result.array(),
    baseline: z.string().array(),
    seq: z.number(),
  })
  .meta({ ref: "CollaborationGroup" })

const GroupSummary = z
  .object({
    sessionID: z.string(),
    title: z.string(),
    /** The project the group works in */
    directory: z.string(),
    seats: Seat.omit({ id: true, privateSessionID: true }).array(),
  })
  .meta({ ref: "CollaborationGroupSummary" })

const Product = z
  .object({
    id: z.string(),
    title: z.string(),
    connected: z.boolean(),
    /** Offered for new members; when false the product is left out of the pickers */
    enabled: z.boolean(),
    /** Why a product cannot take a member, when it cannot */
    reason: z.string().optional(),
    /** One of claude, codex and opencode, or MerakCode itself */
    builtin: z.boolean(),
    /** Where the definition comes from; a project's config is shown but not edited in settings */
    source: z.enum(["builtin", "global", "project"]),
    /** First line of --version, for a CLI that answered */
    version: z.string().optional(),
    /** The command found on this machine */
    path: z.string().optional(),
    /** Version the adapter recommends; an older CLI still works, but should be upgraded */
    recommended: z.string().optional(),
    /** Command that upgrades the CLI */
    upgrade: z.string().optional(),
    /** The CLI found is older than recommended */
    outdated: z.boolean().optional(),
    /** How MerakCode drives the product */
    adapter: z.enum(["claude", "codex", "opencode", "command", "member"]).optional(),
    /** The definition, for the settings form; MerakCode has none */
    command: z.string().optional(),
    args: z.string().array().optional(),
    resumeArgs: z.string().array().optional(),
    sessionLine: z.string().optional(),
  })
  .meta({ ref: "CollaborationProduct" })

const SeatInput = z.object({
  name: z.string(),
  role: z.string().optional().describe("Short title such as product manager"),
  duty: z.string().optional().describe("What the seat is for; it goes into the seat's prompt"),
})

async function fail(error: unknown) {
  if (error instanceof GroupError) return { message: await Text.pick(error.text) }
  throw error
}

async function notConnected(products: { id: string; reason?: string }[]) {
  const lang = await Text.lang()
  const list = products.map((item) => {
    if (!item.reason) return item.id
    return lang === "zh" ? `${item.id}（${item.reason}）` : `${item.id} (${item.reason})`
  })
  return Text.format({ zh: "这些产品未接通：{products}", en: "These products are not connected: {products}" }, lang, {
    products: list.join(lang === "zh" ? "、" : ", "),
  })
}

/** Every product with whether it can take a member now; the reason is in the user's language */
async function products(options: { refresh?: boolean } = {}): Promise<z.infer<typeof Product>[]> {
  const [lang, sourceOf] = await Promise.all([Text.lang(), productSources()])
  const list = await Promise.all(
    (await configuredProducts()).map(async (product) => {
      const { connected, reason, version, path, recommended, upgrade, outdated } = await probe(product, options)
      return {
        id: product.id,
        title: product.title,
        connected,
        enabled: product.enabled !== false,
        reason: reason?.[lang],
        builtin: BUILTIN_PRODUCTS.some((item) => item.id === product.id),
        source: sourceOf(product.id),
        version,
        path,
        recommended,
        upgrade,
        outdated,
        adapter: product.adapter,
        command: product.command,
        args: product.args,
        resumeArgs: product.resumeArgs,
        sessionLine: product.sessionLine,
      }
    }),
  )
  const merak = {
    id: "merak",
    title: "MerakCode",
    connected: true,
    enabled: true,
    builtin: true,
    source: "builtin" as const,
  }
  return [merak, ...list]
}

/** Products a new seat cannot use: turned off, not installed or not running, with the reason */
async function disconnected(seats: { product: string }[]) {
  const list = await products()
  const off = await Text.pick({ zh: "已关闭", en: "turned off" })
  return [...new Set(seats.map((seat) => seat.product))].flatMap((id) => {
    const found = list.find((item) => item.id === id)
    if (found?.enabled === false) return [{ id, reason: off }]
    return found?.connected ? [] : [{ id, reason: found?.reason }]
  })
}

export const CollaborationRoutes = lazy(() =>
  new Hono()
    .get(
      "/product",
      describeRoute({
        summary: "List collaboration products",
        description:
          "Products that can take a seat. Merak is always connected. Others are connected when their command is installed and answers --version within five seconds; otherwise reason says why.",
        operationId: "collaboration.products",
        responses: {
          200: {
            description: "Products",
            content: { "application/json": { schema: resolver(Product.array()) } },
          },
        },
      }),
      validator("query", z.object({ refresh: z.enum(["true", "false"]).optional() })),
      async (c) => c.json(await products({ refresh: c.req.valid("query").refresh === "true" })),
    )
    .post(
      "/product",
      describeRoute({
        summary: "Change collaboration products",
        description:
          "Adds, edits, removes, or turns on or off a product in the global config. Removing a built-in product restores its default.",
        operationId: "collaboration.product.change",
        responses: {
          200: {
            description: "Products",
            content: { "application/json": { schema: resolver(Product.array()) } },
          },
        },
      }),
      validator("json", ProductChange),
      async (c) => {
        try {
          await changeProduct(c.req.valid("json"))
          return c.json(await products())
        } catch (error) {
          return c.json(await fail(error), 400)
        }
      },
    )
    .get(
      "/",
      describeRoute({
        summary: "List collaboration groups",
        description:
          "Groups of every project, most recently active first, with their members for copying into a new group. Private sessions are left out.",
        operationId: "collaboration.list",
        responses: {
          200: {
            description: "Groups",
            content: { "application/json": { schema: resolver(GroupSummary.array()) } },
          },
        },
      }),
      async (c) =>
        c.json(
          (await all()).map(({ session, group }) => ({
            sessionID: session.id,
            title: session.title,
            directory: session.directory,
            seats: group.seats.map(({ name, role, duty, product, leader }) => ({ name, role, duty, product, leader })),
          })),
        ),
    )
    .post(
      "/",
      describeRoute({
        summary: "Create a collaboration group",
        description: "Creates a session whose leader is a Merak seat, together with the seats named up front.",
        operationId: "collaboration.create",
        responses: {
          200: {
            description: "Created group",
            content: {
              "application/json": {
                schema: resolver(z.object({ sessionID: z.string(), group: Group })),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          title: z.string().optional(),
          leader: SeatInput,
          seats: SeatInput.extend({ product: z.string() }).array().optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const seats = body.seats ?? []
        const missing = await disconnected(seats)
        if (missing.length) return c.json({ message: await notConnected(missing) }, 400)
        try {
          // Validate before the session exists, so a bad seat leaves nothing behind
          createGroup(body.leader, seats)
          const baseline = await porcelain(Instance.directory).catch(() => [])
          const title = body.title?.trim() || [body.leader, ...seats].map((seat) => seat.name).join("、")
          const session = await Session.create({ title, metadata: { group: true } })
          const group = await create(
            session.id,
            { leader: body.leader, seats },
            baseline.map((file) => file.path),
          )
          return c.json({ sessionID: session.id, group })
        } catch (error) {
          return c.json(await fail(error), 400)
        }
      },
    )
    .get(
      "/:sessionID",
      describeRoute({
        summary: "Get a collaboration group",
        operationId: "collaboration.get",
        responses: {
          200: {
            description: "Group",
            content: { "application/json": { schema: resolver(Group) } },
          },
        },
      }),
      validator("param", z.object({ sessionID: z.string() })),
      async (c) => {
        const group = await load(c.req.valid("param").sessionID)
        if (!group) return c.json({ message: await Text.pick({ zh: "没有这个群", en: "Group not found" }) }, 404)
        return c.json(group)
      },
    )
    .post(
      "/:sessionID/seat",
      describeRoute({
        summary: "Add a collaboration seat",
        operationId: "collaboration.seat.add",
        responses: {
          200: {
            description: "Updated group",
            content: { "application/json": { schema: resolver(Group) } },
          },
        },
      }),
      validator("param", z.object({ sessionID: z.string() })),
      validator("json", SeatInput.extend({ product: z.string() })),
      async (c) => {
        const { sessionID } = c.req.valid("param")
        const body = c.req.valid("json")
        const missing = await disconnected([body])
        if (missing.length) return c.json({ message: await notConnected(missing) }, 400)
        try {
          return c.json(await join(sessionID, body))
        } catch (error) {
          return c.json(await fail(error), 400)
        }
      },
    )
    .patch(
      "/:sessionID/seat/:seatID",
      describeRoute({
        summary: "Change a collaboration seat's name, role or duty",
        operationId: "collaboration.seat.update",
        responses: {
          200: {
            description: "Updated group",
            content: { "application/json": { schema: resolver(Group) } },
          },
        },
      }),
      validator("param", z.object({ sessionID: z.string(), seatID: z.string() })),
      validator("json", SeatInput.partial()),
      async (c) => {
        const { sessionID, seatID } = c.req.valid("param")
        try {
          return c.json(await update(sessionID, seatID, c.req.valid("json")))
        } catch (error) {
          return c.json(await fail(error), 400)
        }
      },
    )
    .delete(
      "/:sessionID/seat/:seatID",
      describeRoute({
        summary: "Remove a collaboration seat",
        description: "The Merak leader cannot be removed.",
        operationId: "collaboration.seat.remove",
        responses: {
          200: {
            description: "Updated group",
            content: { "application/json": { schema: resolver(Group) } },
          },
        },
      }),
      validator("param", z.object({ sessionID: z.string(), seatID: z.string() })),
      async (c) => {
        const { sessionID, seatID } = c.req.valid("param")
        try {
          return c.json(await leave(sessionID, seatID))
        } catch (error) {
          return c.json(await fail(error), 400)
        }
      },
    ),
)

import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { validator } from "../validator"
import { RuleManage } from "../../rule/manage"
import { RuleManageContract } from "../../rule/manage-contract"
import { lazy } from "../../util/lazy"
import { errors } from "../error"

export const RuleRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Read rules",
        description:
          "Read user rules, project rule files (.mdc) and effective instruction files as one consistent snapshot.",
        operationId: "ruleManagement.read",
        responses: {
          200: {
            description: "Complete rule management snapshot",
            content: { "application/json": { schema: resolver(RuleManageContract.Snapshot) } },
          },
        },
      }),
      async (c) => c.json(await RuleManage.read()),
    )
    .post(
      "/change",
      describeRoute({
        summary: "Change rules",
        description: "Create, edit or delete user rules, project rule files and instruction files.",
        operationId: "ruleManagement.change",
        responses: {
          200: {
            description: "Rule management result",
            content: { "application/json": { schema: resolver(RuleManageContract.Result) } },
          },
          ...errors(400),
        },
      }),
      validator("json", RuleManageContract.Command),
      async (c) => c.json(await RuleManage.change(c.req.valid("json"))),
    ),
)

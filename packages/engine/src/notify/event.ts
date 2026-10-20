import { BusEvent } from "../bus/bus-event"
import z from "zod"

/**
 * General notification events, not specific to the TUI. Backend modules such as LSP, MCP and server routes push
 * toasts through them; both the TUI and the web client consume them.
 */
export const NotifyEvent = {
  ToastShow: BusEvent.define(
    "notify.toast.show",
    z.object({
      title: z.string().optional(),
      message: z.string(),
      variant: z.enum(["info", "success", "warning", "error"]),
      duration: z.number().default(5000).optional().describe("Duration in milliseconds"),
      // Structured, localizable title and message
      titleCode: z.string().optional(),
      messageCode: z.string().optional(),
      params: z.record(z.string(), z.any()).optional(),
    }),
  ),
}

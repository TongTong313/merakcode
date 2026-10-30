import z from "zod"
import { BusEvent } from "../bus/bus-event"

export const ConfigUpdated = BusEvent.define("config.updated", z.object({}))

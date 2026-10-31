import { Process } from "@merakcode/util/process"
import { containProcess } from "../../infra/process/tree"
import { Text } from "../prompt/text"

/** Owns the adapter's descendants before its first protocol request can start a CLI. */
export function containAdapter(child: Process.Child, marker: string): Promise<() => Promise<void>> {
  return containProcess(child, { name: "MERAKCODE_ADAPTER_RUN", value: marker }, Text.pick)
}

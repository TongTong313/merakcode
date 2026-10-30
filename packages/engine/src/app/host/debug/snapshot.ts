import { Config } from "@merakcode/engine/agent/settings/index"
import { cleanupSnapshots } from "@merakcode/engine/app/project/snapshots"
// `merak debug snapshot`: inspect and restore file snapshots taken during sessions.
import { Snapshot } from "../../../infra/project/snapshot/index"
import { withInstance } from "../bootstrap"
export async function track(args: { sessionID: string }) {
  await withInstance(process.cwd(), async () => {
    const backupID = await Snapshot.track(args.sessionID, (await Config.get()).snapshot !== false)
    console.log("backupID:", backupID)
  })
}

export async function patch(args: { sessionID: string; backupID: string }) {
  await withInstance(process.cwd(), async () => {
    const result = await Snapshot.patch(args.backupID, args.sessionID)
    console.log(JSON.stringify(result, null, 2))
  })
}

export async function diff(args: { sessionID: string; backupID: string }) {
  await withInstance(process.cwd(), async () => {
    const result = await Snapshot.diff(args.backupID, args.sessionID)
    console.log(result)
  })
}

export async function restore(args: { sessionID: string; backupID: string }) {
  await withInstance(process.cwd(), async () => {
    const restored = await Snapshot.restore(args.backupID, args.sessionID)
    console.log("Restored files:", restored)
  })
}

export async function cleanup() {
  await withInstance(process.cwd(), async () => {
    await cleanupSnapshots()
    console.log("Cleanup done")
  })
}

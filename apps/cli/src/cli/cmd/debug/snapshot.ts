import { cmd } from "../cmd"
import { host } from "./host"
import { I18n } from "../../i18n"

export const SnapshotCommand = cmd({
  command: "snapshot",
  describe: I18n.t("cli.debug.snapshot"),
  builder: (yargs) =>
    yargs
      .command(TrackCommand)
      .command(PatchCommand)
      .command(DiffCommand)
      .command(RestoreCommand)
      .command(CleanupCommand)
      .demandCommand(),
  async handler() {},
})

const TrackCommand = cmd({
  command: "track <sessionID>",
  describe: I18n.t("cli.debug.snapshot.track"),
  builder: (yargs) =>
    yargs.positional("sessionID", {
      type: "string",
      description: I18n.t("cli.debug.sessionID"),
      demandOption: true,
    }),
  async handler(args) {
    const m = await (await host()).debug.snapshot()
    return m.track(args)
  },
})

const PatchCommand = cmd({
  command: "patch <sessionID> <backupID>",
  describe: I18n.t("cli.debug.snapshot.patch"),
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        type: "string",
        description: I18n.t("cli.debug.sessionID"),
        demandOption: true,
      })
      .positional("backupID", {
        type: "string",
        description: I18n.t("cli.debug.backupID"),
        demandOption: true,
      }),
  async handler(args) {
    const m = await (await host()).debug.snapshot()
    return m.patch(args)
  },
})

const DiffCommand = cmd({
  command: "diff <sessionID> <backupID>",
  describe: I18n.t("cli.debug.snapshot.diff"),
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        type: "string",
        description: I18n.t("cli.debug.sessionID"),
        demandOption: true,
      })
      .positional("backupID", {
        type: "string",
        description: I18n.t("cli.debug.backupID"),
        demandOption: true,
      }),
  async handler(args) {
    const m = await (await host()).debug.snapshot()
    return m.diff(args)
  },
})

const RestoreCommand = cmd({
  command: "restore <sessionID> <backupID>",
  describe: I18n.t("cli.debug.snapshot.restore"),
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        type: "string",
        description: I18n.t("cli.debug.sessionID"),
        demandOption: true,
      })
      .positional("backupID", {
        type: "string",
        description: I18n.t("cli.debug.backupID"),
        demandOption: true,
      }),
  async handler(args) {
    const m = await (await host()).debug.snapshot()
    return m.restore(args)
  },
})

const CleanupCommand = cmd({
  command: "cleanup",
  describe: I18n.t("cli.debug.snapshot.cleanup"),
  async handler() {
    const m = await (await host()).debug.snapshot()
    return m.cleanup()
  },
})

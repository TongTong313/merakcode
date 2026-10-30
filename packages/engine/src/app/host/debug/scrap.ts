// `merak debug scrap`: list known projects.
import { EOL } from "os"
import { Project } from "../../../infra/project/project"
import { Log } from "@merakcode/log/logger"

export async function run() {
  const timer = Log.Product.time("scrap")
  const list = await Project.list()
  process.stdout.write(JSON.stringify(list, null, 2) + EOL)
  timer.stop()
}

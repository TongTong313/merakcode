// `merak debug config`: print the fully resolved configuration.
import { EOL } from "os"
import { Config } from "../../config/config"
import { withInstance } from "../bootstrap"

export async function run() {
  await withInstance(process.cwd(), async () => {
    const config = await Config.get()
    process.stdout.write(JSON.stringify(config, null, 2) + EOL)
  })
}

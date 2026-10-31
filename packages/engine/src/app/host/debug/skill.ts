// `merak debug skill`: list discovered skills.
import { EOL } from "os"
import { Skill } from "../../../agent/skill/index"
import { withInstance } from "../bootstrap"

export async function run() {
  await withInstance(process.cwd(), async () => {
    const skills = await Skill.all()
    process.stdout.write(JSON.stringify(skills, null, 2) + EOL)
  })
}

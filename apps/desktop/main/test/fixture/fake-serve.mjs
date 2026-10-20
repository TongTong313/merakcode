// Fake `serve`: listens on --port and prints the same ready line as the real backend. Controlled by env variables:
//   FAKE_CRASH_FILE  if the number in the file is > 0, exits 200ms after ready and decrements it (simulates a crash)
//   FAKE_FAIL=1      does not listen; writes an error line to stderr and exits with 3
import fs from "node:fs"
import http from "node:http"
const port = Number(process.argv[process.argv.indexOf("--port") + 1])
if (process.env.FAKE_FAIL === "1") {
  process.stderr.write("node: error while loading shared libraries: libatomic.so.1\n")
  process.exit(3)
}
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json")
  res.end(
    JSON.stringify({ auth: req.headers.authorization ?? null, client: process.env.MERAKCODE_CLIENT, pid: process.pid }),
  )
})
server.listen(port, "127.0.0.1", () => {
  console.log(`MerakCode server listening on http://127.0.0.1:${server.address().port}`)
  const file = process.env.FAKE_CRASH_FILE
  const left = file && fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0
  if (left > 0) {
    fs.writeFileSync(file, String(left - 1))
    setTimeout(() => process.exit(1), 200)
  }
})
process.on("disconnect", () => server.close(() => process.exit(0)))

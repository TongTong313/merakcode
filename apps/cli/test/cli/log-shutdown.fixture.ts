import "../../src/product-version"
import { Log } from "@merakcode/log/logger"

const shutdown = Log.shutdown
const product = Log.create({ service: "shutdown.product", source: "product" })
const sdk = Log.create({ service: "shutdown.sdk" })

// Queue records at the real CLI exit boundary; keep the SDK writer and shutdown implementation intact.
Log.shutdown = () => {
  Array.from({ length: 20 }, (_, index) => {
    product.info("shutdown fixture completed", { index })
    sdk.info("shutdown fixture completed", { index })
  })
  return shutdown()
}

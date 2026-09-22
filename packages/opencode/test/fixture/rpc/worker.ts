import { Rpc } from "../../../src/util/rpc"

// Mirrors the TUI worker: rejected handlers must still return an RPC failure.
process.on("unhandledRejection", () => {})

export const rpc = {
  echo(input: string) {
    return input
  },
  fail() {
    throw new TypeError("fixture failure")
  },
  async reject() {
    await Bun.sleep(1)
    throw new Error("async fixture failure")
  },
  unserializable() {
    return 1n
  },
  async delayed(input: number) {
    await Bun.sleep(input)
    return "finished"
  },
  async stop() {
    await Bun.sleep(10)
    process.exit(0)
  },
  async fetch(input: { url: string }) {
    await Bun.sleep(100)
    return { status: 200, headers: {}, body: input.url }
  },
}
Rpc.listen(rpc)

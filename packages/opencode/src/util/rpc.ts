type Definition = Record<string, (input: never) => unknown>

type Request = { type: "rpc.request"; method: string; input: never; id: number }
type Response =
  | { type: "rpc.result"; result: unknown; id: number }
  | { type: "rpc.error"; error: { name: string; message: string }; id: number }
  | { type: "rpc.event"; event: string; data: unknown }

export function listen(rpc: Definition) {
  onmessage = async (evt) => {
    const parsed: Request = JSON.parse(evt.data)
    if (parsed.type !== "rpc.request") return
    try {
      const result = await rpc[parsed.method](parsed.input)
      postMessage(JSON.stringify({ type: "rpc.result", result, id: parsed.id }))
    } catch (error) {
      postMessage(
        JSON.stringify({
          type: "rpc.error",
          id: parsed.id,
          error:
            error instanceof Error
              ? { name: error.name, message: error.message }
              : { name: "Error", message: "Worker request failed" },
        }),
      )
    }
  }
}

export function emit(event: string, data: unknown) {
  postMessage(JSON.stringify({ type: "rpc.event", event, data }))
}

export function client<T extends Definition>(target: Worker) {
  const pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: unknown) => void }>()
  const listeners = new Map<string, Set<(data: unknown) => void>>()
  let id = 0
  let closed: Error | undefined

  const dispose = (error = new Error("Worker RPC closed")) => {
    if (closed) return
    closed = error
    target.removeEventListener("message", receive)
    target.removeEventListener("error", failed)
    target.removeEventListener("messageerror", failed)
    target.removeEventListener("close", stopped)
    for (const request of pending.values()) request.reject(error)
    pending.clear()
    listeners.clear()
  }
  const failed = () => dispose(new Error("Worker RPC failed"))
  const stopped = () => dispose(new Error("Worker RPC closed"))
  const receive = async (evt: MessageEvent<string>) => {
    const parsed: Response = JSON.parse(evt.data)
    if (parsed.type === "rpc.event") {
      for (const handler of listeners.get(parsed.event) ?? []) handler(parsed.data)
      return
    }
    const request = pending.get(parsed.id)
    if (!request) return
    pending.delete(parsed.id)
    if (parsed.type === "rpc.error") {
      request.reject(Object.assign(new Error(parsed.error.message), { name: parsed.error.name }))
      return
    }
    request.resolve(parsed.result)
  }
  target.addEventListener("message", receive)
  target.addEventListener("error", failed)
  target.addEventListener("messageerror", failed)
  target.addEventListener("close", stopped)

  return {
    call<Method extends keyof T>(
      method: Method,
      input: Parameters<T[Method]>[0],
      signal?: AbortSignal,
    ): Promise<Awaited<ReturnType<T[Method]>>> {
      if (closed) return Promise.reject(closed)
      if (signal?.aborted) return Promise.reject(signal.reason)
      const requestId = id++
      return new Promise<Awaited<ReturnType<T[Method]>>>((resolve, reject) => {
        const abort = () => {
          pending.delete(requestId)
          reject(signal!.reason)
        }
        const cleanup = () => signal?.removeEventListener("abort", abort)
        pending.set(requestId, {
          resolve: (result) => {
            cleanup()
            resolve(result as Awaited<ReturnType<T[Method]>>)
          },
          reject: (error) => {
            cleanup()
            reject(error)
          },
        })
        signal?.addEventListener("abort", abort, { once: true })
        try {
          target.postMessage(JSON.stringify({ type: "rpc.request", method, input, id: requestId }))
        } catch (error) {
          pending.delete(requestId)
          cleanup()
          reject(error)
        }
      })
    },
    on<Data>(event: string, handler: (data: Data) => void) {
      if (closed) return () => {}
      const listener = (data: unknown) => handler(data as Data)
      const handlers = listeners.get(event) ?? new Set<(data: unknown) => void>()
      listeners.set(event, handlers)
      handlers.add(listener)
      return () => {
        handlers.delete(listener)
        if (!handlers.size) listeners.delete(event)
      }
    },
    dispose,
  }
}

export * as Rpc from "./rpc"

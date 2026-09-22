import type { InstanceContext } from "@/project/instance-context"

const disposers = new Set<(context: InstanceContext) => Promise<void>>()

export function registerDisposer(disposer: (context: InstanceContext) => Promise<void>) {
  disposers.add(disposer)
  return () => {
    disposers.delete(disposer)
  }
}

export async function disposeInstance(context: InstanceContext) {
  await Promise.allSettled([...disposers].map((disposer) => disposer(context)))
}

export * as InstanceRegistry from "./instance-registry"

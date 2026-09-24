export interface StopOperationStore {
  get(key: string): string | undefined
  set(key: string, value: string | undefined): Promise<unknown>
}

export function stopOperationKey(parentSessionID: string, childSessionID: string) {
  return `task-stop:${parentSessionID}:${childSessionID}`
}

export async function submitTaskStop<T>(input: {
  store: StopOperationStore
  parentSessionID: string
  childSessionID: string
  retry: boolean
  send: (operationID: string) => Promise<T>
}) {
  const key = stopOperationKey(input.parentSessionID, input.childSessionID)
  const previous = input.store.get(key)
  if (input.retry && !previous) throw new Error("No original stop operation to retry")
  if (!input.retry && previous) throw new Error("Retry the original stop before starting another")
  const operationID = previous ?? crypto.randomUUID()
  await input.store.set(key, operationID)
  const result = await input.send(operationID)
  await input.store.set(key, undefined)
  return result
}

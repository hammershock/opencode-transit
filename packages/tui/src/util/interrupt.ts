import type { useSDK } from "../context/sdk"

/** The legacy-compatible endpoint routes to the live Session owner, regardless of transcript backend. */
export function interruptSession(sdk: ReturnType<typeof useSDK>, sessionID: string) {
  return sdk.client.session.abort(
    { sessionID },
    { throwOnError: true, headers: { "x-opencode-interrupt-id": crypto.randomUUID() } },
  )
}

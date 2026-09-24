export async function promptBackend(
  sessionID: string,
  request: (pathname: string) => Promise<Response>,
): Promise<"v2" | "legacy"> {
  const response = await request(`/api/session/${encodeURIComponent(sessionID)}/prompt/backend`)
  if (response.status === 404 || response.status === 501) return "legacy"
  if (!response.ok) throw new Error(`Prompt backend unavailable (${response.status})`)
  const body: unknown = await response.json()
  if (
    !body ||
    typeof body !== "object" ||
    !("data" in body) ||
    (body.data !== "v2" && body.data !== "legacy")
  )
    throw new Error("Invalid prompt backend response")
  return body.data
}

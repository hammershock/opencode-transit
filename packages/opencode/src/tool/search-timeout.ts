import { Effect, Schema } from "effect"
import { PositiveInt } from "@opencode-ai/core/schema"

export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000
export const MAX_TIMEOUT_MS = 10 * 60 * 1_000

export const Timeout = PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_TIMEOUT_MS))
  .pipe(Schema.optional)
  .annotate({
    description: `Search timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}; maximum ${MAX_TIMEOUT_MS}.`,
  })

export const enforce = <A, E, R>(
  search: (signal: AbortSignal) => Effect.Effect<A, E, R>,
  timeout: number | undefined,
  abort: AbortSignal,
) =>
  Effect.suspend(() => {
    // A separate abort clock is absolute; progress cannot reset it and the
    // ripgrep adapter closes its process scope when this signal aborts.
    const deadline = AbortSignal.timeout(timeout ?? DEFAULT_TIMEOUT_MS)
    return search(AbortSignal.any([abort, deadline])).pipe(
      Effect.catch((error) =>
        deadline.aborted && !abort.aborted
          ? Effect.die(
              new Error(`Search timed out after ${timeout ?? DEFAULT_TIMEOUT_MS} ms. Retry with a longer timeout.`),
            )
          : Effect.fail(error),
      ),
    )
  })

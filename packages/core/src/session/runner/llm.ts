import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  Message,
  SystemPart,
  isContextOverflowFailure,
  type ProviderErrorEvent,
} from "@opencode-ai/llm"
import { Cause, DateTime, Effect, Equal, Exit, FiberSet, Layer, Option, Semaphore, Stream } from "effect"
import { AgentV2 } from "../../agent"
import { Config } from "../../config"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { Location } from "../../location"
import { ModelV2 } from "../../model"
import { PermissionV2 } from "../../permission"
import { ExecutionPolicy } from "../../permission/policy"
import { ProviderV2 } from "../../provider"
import { QuestionV2 } from "../../question"
import { RuntimeContext } from "../../runtime-context"
import { RuntimeContextBuiltIns } from "../../runtime-context/builtins"
import { ToolRegistry } from "../../tool/registry"
import { ToolOutputStore } from "../../tool-output-store"
import { SessionCompaction } from "../compaction"
import { SessionEvent } from "../event"
import { SessionHistory } from "../history"
import { SessionInput } from "../input"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionTurn } from "../turn"
import { SessionTask } from "../task"
import { SessionMessage } from "../message"
import { type RunError, Service } from "./index"
import { SessionRunnerModel } from "./model"
import { createLLMEventPublisher } from "./publish-llm-event"
import { toLLMMessages } from "./to-llm-message"
import { MAX_STEPS_PROMPT } from "./max-steps"
import { SessionAgentGuidance } from "../agent-guidance"
import { SessionInterruption } from "../interruption"
import { SessionPeerRoute } from "../peer-route"
import { Snapshot } from "../../snapshot"
import { makeLocationNode } from "../../effect/app-node"
import { llmClient } from "../../effect/app-node-platform"
import { SessionInputTable, SessionPeerMessageTable, SessionPeerReceiptTable, SessionTaskResultTable } from "../sql"
import { and, desc, eq, inArray, isNotNull, ne } from "drizzle-orm"

/**
 * Runs one durable coding-agent Session until it settles.
 *
 * Keep this as orchestration over smaller collaborators rather than rebuilding the legacy
 * `SessionPrompt` monolith. Implement the unchecked items in small reviewed slices:
 *
 * - Session ownership and controls
 *   - [x] Coordinate one local active drain per Session; explicit resumes join and prompt wakeups coalesce.
 *   - [ ] Replace local ownership with durable multi-node ownership when clustered.
 *   - [ ] Mark busy, retrying, idle, interrupted, or terminal-failure status durably.
 *   - [ ] Honor interruption and reject stale work after runtime attachment replacement.
 *   - [x] Honor optional agent step limits.
 *   - [ ] Bound provider retries and repeated identical tool calls.
 *
 * - Runtime context assembly
 *   - Track V1 runtime-context parity canonically in `specs/v2/session.md`.
 *
 * - One provider turn
 *   - [x] Translate every projected V2 Session message variant into canonical
 *     `@opencode-ai/llm` messages.
 *   - [ ] Resolve policy-filtered built-in, MCP, plugin, and structured-output tool definitions.
 *   - [x] Stream exactly one `llm.stream(request)` provider turn.
 *   - [x] Persist assistant text and usage events incrementally as they arrive.
 *   - [ ] Persist snapshots, patches, and retry notices incrementally as they arrive.
 *   - [x] Persist reasoning, provider errors, and tool-call events incrementally as they arrive.
 *
 * - Tool settlement and continuation
 *   - [x] Durably record each tool call before side effects begin.
 *   - [x] Authorize and execute recorded local calls through a core-owned registry hook.
 *   - [x] Persist typed success, failure, and provider-executed tool outcomes.
 *   - [x] Start each recorded local call eagerly and await all settlements before continuation.
 *   - [ ] Add scoped runtime context, progress updates, attachment normalization,
 *     plugins, and cancellation settlement.
 *   - [x] Reload projected history and start the next explicit provider turn after local tool results.
 *   - [x] Continue for durable user steering accepted during an active provider turn.
 *   - [ ] Continue for compaction or another continuation condition when required.
 *
 * - Post-run maintenance
 *   - [ ] Settle final status and expose durable output events to replayable consumers.
 *   - [ ] Coalesce streamed deltas and add covering projected-history indexes.
 *   - [ ] Update title, summaries, compaction state, and cleanup in bounded background work.
 *
 * Use `llm.stream(request)` for each provider turn. Keep tool execution and continuation here.
 * Durable continuation recovery remains a separate future slice with an explicit retry policy.
 *
 * The current slice loads V2 history, translates it, resolves a model through a core service, and persists one
 * provider turn. Registry definitions are advertised, local tool calls are settled durably, and an
 * explicit loop starts the next provider turn after local settlement. Configured agent step limits bound the loop.
 */

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const llm = yield* LLMClient.Service
    const agents = yield* AgentV2.Service
    const tools = yield* ToolRegistry.Service
    const policy = yield* ExecutionPolicy.Service
    const models = yield* SessionRunnerModel.Service
    const store = yield* SessionStore.Service
    const location = yield* Location.Service
    const config = yield* Config.Service
    const snapshots = yield* Snapshot.Service
    const runtime = yield* RuntimeContext.Service
    const database = yield* Database.Service
    const db = database.db
    const compaction = SessionCompaction.make({ events, llm, config: yield* config.entries() })
    const compactManual = Effect.fn("SessionRunner.compactManual")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly model?: ModelV2.Ref
    }) {
      const session = yield* getSession(input.sessionID)
      const model = yield* models.resolve({ ...session, model: input.model ?? session.model })
      const entries = yield* SessionHistory.entriesForRunner(db, session.id)
      yield* compaction.compactManual({
        sessionID: session.id,
        entries,
        model,
        http: {
          headers: {
            "x-session-affinity": session.id,
            "X-Session-Id": session.id,
            ...(session.parentID ? { "x-parent-session-id": session.parentID } : {}),
          },
        },
      })
    })
    const getSession = Effect.fn("SessionRunner.getSession")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
      return session
    })

    const getContext = Effect.fn("SessionRunner.getContext")(function* (sessionID: SessionSchema.ID) {
      return yield* store.context(sessionID)
    })
    const generateTitle = Effect.fn("SessionRunner.generateTitle")(function* (sessionID: SessionSchema.ID) {
      const session = yield* getSession(sessionID)
      if (session.parentID || !/^New session - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(session.title)) return
      const users = (yield* getContext(sessionID)).filter(
        (message) => message.type === "user" && !/^\/(target|env)\s/.test(message.text.trim()),
      )
      const first = users[0]
      if (!first || first.type !== "user") return
      const titleAgent = yield* agents.get(AgentV2.ID.make("title"))
      if (!titleAgent) return
      const admitted = yield* SessionInput.find(db, first.id)
      const model = yield* models.resolve({
        ...session,
        model: titleAgent.model ?? admitted?.prompt.selection?.model ?? session.model,
      })
      const chunks: string[] = []
      let failed = false
      yield* llm
        .stream(
          LLM.request({
            model,
            system: titleAgent.system ? [SystemPart.make(titleAgent.system)] : [],
            messages: [Message.user(`Generate a title for this conversation:\n${first.text}`)],
            tools: [],
            generation: { maxTokens: 80 },
          }),
        )
        .pipe(
          Stream.runForEach((event) => {
            if (LLMEvent.is.providerError(event)) failed = true
            if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
            return Effect.void
          }),
        )
      if (failed) return
      const title = chunks
        .join("")
        .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      if (!title) return
      yield* events.publish(SessionEvent.TitleGenerated, {
        sessionID,
        timestamp: yield* DateTime.now,
        title: title.length > 100 ? `${title.slice(0, 97)}...` : title,
      })
    })
    const failInterruptedTools = Effect.fn("SessionRunner.failInterruptedTools")(function* (
      sessionID: SessionSchema.ID,
    ) {
      for (const message of yield* getContext(sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "pending" && tool.state.status !== "running")) continue
          yield* events.publish(SessionEvent.Tool.Failed, {
            sessionID,
            timestamp: yield* DateTime.now,
            assistantMessageID: message.id,
            callID: tool.id,
            error: { type: "unknown", message: "Tool execution interrupted" },
            provider: {
              executed: tool.provider?.executed === true,
              ...(tool.provider?.metadata === undefined ? {} : { metadata: tool.provider.metadata }),
            },
          })
        }
      }
    })

    const awaitToolFibers = (fibers: FiberSet.FiberSet<void, ToolOutputStore.Error>) =>
      Effect.raceFirst(FiberSet.join(fibers), FiberSet.awaitEmpty(fibers))

    // Match V1: declining a user prompt halts the loop instead of becoming model-facing tool output.
    const isUserDeclined = (cause: Cause.Cause<unknown>) =>
      cause.reasons.some(
        (reason) =>
          Cause.isDieReason(reason) &&
          (reason.defect instanceof PermissionV2.DeclinedError || reason.defect instanceof QuestionV2.RejectedError),
      )

    type TurnTransition =
      // Automatic compaction completed; rebuild the request from compacted history.
      | { readonly _tag: "ContinueAfterCompaction"; readonly step: number }
      // Overflow compaction completed; rebuild once through the path without overflow recovery.
      | { readonly _tag: "ContinueAfterOverflowCompaction"; readonly step: number }

    class TurnTransitionError extends Error {
      constructor(readonly transition: TurnTransition) {
        super()
      }
    }

    const continueAfterCompaction = (step: number) => new TurnTransitionError({ _tag: "ContinueAfterCompaction", step })
    const continueAfterOverflowCompaction = (step: number) =>
      new TurnTransitionError({ _tag: "ContinueAfterOverflowCompaction", step })

    const runTurnAttempt = Effect.fn("SessionRunner.runTurn")(function* (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      onPromoted: (inputs: ReadonlyArray<SessionInput.Admitted>) => void,
      recoverOverflow?: typeof compaction.compactAfterOverflow,
    ) {
      const session = yield* getSession(sessionID)
      if (
        session.location.directory !== location.directory ||
        session.location.workspaceID !== location.workspaceID ||
        !Equal.equals(session.location.target, location.target)
      )
        return yield* Effect.interrupt
      const toolFibers = yield* FiberSet.make<void, ToolOutputStore.Error>()
      let needsContinuation = false
      let currentStep = step
      let promoted: ReadonlyArray<SessionInput.Admitted> = []
      if (promotion) {
        const cutoff = yield* EventV2.latestSequence(db, session.id)
        if (promotion === "steer") promoted = yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        if (promotion === "queue") {
          const queued = yield* SessionInput.promoteNextQueued(db, events, session.id)
          const steers = yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
          promoted = queued ? [queued, ...steers] : steers
        }
        if (promotion === "queue" && promoted.length === 0)
          return { needsContinuation: false, step: currentStep, failed: false }
        if (promoted.length > 0) {
          onPromoted(promoted)
          if (promoted.some((input) => input.origin?.kind !== "peer_message" || input.delivery === "queue"))
            currentStep = 1
        }
      }
      const latest = yield* db
        .select({ id: SessionInputTable.id })
        .from(SessionInputTable)
        .where(and(eq(SessionInputTable.session_id, session.id), isNotNull(SessionInputTable.promoted_seq)))
        .orderBy(desc(SessionInputTable.promoted_seq))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      const selection = latest
        ? (yield* SessionInput.find(db, SessionMessage.ID.make(latest.id)))?.prompt.selection
        : undefined
      const selected = {
        ...session,
        agent: selection?.agent ? AgentV2.ID.make(selection.agent) : session.agent,
        model: selection?.model ?? session.model,
      }
      const agent = yield* agents.select(selected.agent)
      const model = yield* models.resolve(selected).pipe(
        Effect.tapError((error) =>
          createLLMEventPublisher(events, {
            sessionID: session.id,
            agent: agent.id,
            model: selected.model ?? {
              providerID: ProviderV2.ID.make("unknown"),
              id: ModelV2.ID.make("unknown"),
            },
          }).failAssistant(error.message),
        ),
      )
      const commandTasks = promoted.flatMap((input) =>
        input.prompt.command?.subtask ? [input.prompt.command.subtask] : [],
      )
      if (commandTasks.length > 0) {
        const materialized = yield* tools.materialize()
        let resultMessageID: SessionMessage.ID | undefined
        for (const task of commandTasks) {
          const publisher = createLLMEventPublisher(events, {
            sessionID: session.id,
            agent: task.agent,
            model: task.model,
          })
          const call = LLMEvent.toolCall({
            id: crypto.randomUUID(),
            name: "task",
            input: {
              prompt: task.prompt,
              description: task.description,
              subagent_type: task.agent,
            },
          })
          yield* publisher.publish(call)
          const assistantMessageID = yield* publisher.assistantMessageID(call.id)
          const settlement = yield* materialized.settle({
            sessionID: session.id,
            agent: AgentV2.ID.make(task.agent),
            assistantMessageID,
            call,
            origin: "command",
          })
          yield* publisher.publish(
            LLMEvent.toolResult({
              id: call.id,
              name: call.name,
              result: settlement.result,
              output: settlement.output,
            }),
            settlement.outputPaths ?? [],
          )
          yield* events.publish(SessionEvent.Step.Ended, {
            sessionID: session.id,
            timestamp: yield* DateTime.now,
            assistantMessageID,
            finish: "tool-calls",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })
          resultMessageID = assistantMessageID
        }
        return { needsContinuation: true, step: currentStep, failed: false, resultMessageID }
      }
      const runtimeParts = yield* runtime.assemble(session.id, agent)
      const entries = yield* SessionHistory.entriesForRunner(db, session.id)
      const context = entries.map((entry) => entry.message)
      const isLastStep = agent.info?.steps !== undefined && currentStep >= agent.info.steps
      const toolMaterialization = isLastStep
        ? undefined
        : yield* Effect.gen(function* () {
            const snapshot = yield* policy.resolve(session.id, agent.id).pipe(Effect.orDie)
            return yield* tools.materialize(snapshot.rules, [
              ...snapshot.ceilings,
              ...(session.parentID ? [[{ action: "slash_command", resource: "*", effect: "deny" as const }]] : []),
            ])
          })
      const promptCacheKey = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id
      const agentGuidance = toolMaterialization?.definitions.some((tool) => tool.name === "agent_interact")
        ? yield* Effect.gen(function* () {
            const routes = yield* SessionPeerRoute.list(session.id).pipe(
              Effect.provideService(Database.Service, database),
            )
            const interruption = yield* SessionInterruption.latest(session.id).pipe(
              Effect.provideService(Database.Service, database),
            )
            return SessionAgentGuidance.render(
              routes.filter((route) => route.can_interact).map((route) => route.alias),
              interruption?.state === "interrupted" ? { actor: interruption.actor_kind } : undefined,
            )
          })
        : undefined
      const request = LLM.request({
        model,
        http: {
          headers: {
            "x-session-affinity": session.id,
            "X-Session-Id": session.id,
            ...(session.parentID ? { "x-parent-session-id": session.parentID } : {}),
          },
        },
        providerOptions: { openai: { promptCacheKey } },
        system: [agent.info?.system, ...runtimeParts.map((part) => part.text), agentGuidance]
          .filter((part): part is string => part !== undefined && part.length > 0)
          .map(SystemPart.make),
        messages: [...toLLMMessages(context, model), ...(isLastStep ? [Message.assistant(MAX_STEPS_PROMPT)] : [])],
        tools: toolMaterialization?.definitions ?? [],
        toolChoice: isLastStep ? "none" : undefined,
      })
      if (yield* compaction.compactIfNeeded({ sessionID: session.id, entries, model, request }))
        return yield* Effect.die(continueAfterCompaction(currentStep))
      const startSnapshot = yield* snapshots.capture()
      const publisher = createLLMEventPublisher(events, {
        sessionID: session.id,
        agent: agent.id,
        model: {
          id: ModelV2.ID.make(model.id),
          providerID: ProviderV2.ID.make(model.provider),
          ...(selected.model?.variant === undefined ? {} : { variant: selected.model.variant }),
        },
        snapshot: startSnapshot,
      })
      const withPublication = Semaphore.makeUnsafe(1).withPermit
      const publish = (event: LLMEvent, outputPaths: ReadonlyArray<string> = []) =>
        withPublication(publisher.publish(event, outputPaths))
      let overflowFailure: ProviderErrorEvent | undefined
      const visiblePeerIDs = context.map((item) => item.id)
      if (visiblePeerIDs.length > 0)
        yield* Effect.gen(function* () {
          const replies = yield* db
            .select({ id: SessionPeerMessageTable.id })
            .from(SessionPeerMessageTable)
            .where(
              and(
                eq(SessionPeerMessageTable.target_session_id, session.id),
                eq(SessionPeerMessageTable.kind, "reply"),
                inArray(SessionPeerMessageTable.id, visiblePeerIDs),
              ),
            )
            .all()
            .pipe(Effect.orDie)
          for (const reply of replies)
            yield* db
              .insert(SessionPeerReceiptTable)
              .values({
                message_id: reply.id,
                receiver_session_id: session.id,
                channel: "inbox",
                time_consumed: Date.now(),
              })
              .onConflictDoNothing()
              .run()
              .pipe(Effect.orDie)
          const taskResults = yield* db
            .select({ id: SessionTaskResultTable.notification_input_id })
            .from(SessionTaskResultTable)
            .where(inArray(SessionTaskResultTable.notification_input_id, visiblePeerIDs))
            .all()
            .pipe(Effect.orDie)
          for (const result of taskResults)
            yield* db
              .insert(SessionPeerReceiptTable)
              .values({
                message_id: result.id,
                receiver_session_id: session.id,
                channel: "inbox",
                time_consumed: Date.now(),
              })
              .onConflictDoNothing()
              .run()
              .pipe(Effect.orDie)
          yield* db
            .update(SessionPeerMessageTable)
            .set({ delivery: "delivered", time_delivered: Date.now() })
            .where(
              and(
                eq(SessionPeerMessageTable.target_session_id, session.id),
                eq(SessionPeerMessageTable.backend, "v2"),
                ne(SessionPeerMessageTable.delivery, "delivered"),
                inArray(SessionPeerMessageTable.id, visiblePeerIDs),
              ),
            )
            .run()
            .pipe(Effect.orDie)
        })
      const providerStream = llm.stream(request).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (overflowFailure || publisher.hasProviderError()) return
            if (LLMEvent.is.providerError(event)) {
              if (isContextOverflowFailure(event) && !publisher.hasAssistantStarted()) {
                overflowFailure = event
                return
              }
            }
            yield* publish(event)
            if (event.type !== "tool-call" || event.providerExecuted) return
            if (!toolMaterialization) {
              yield* withPublication(publisher.failUnsettledTools("Tools are disabled after the maximum agent steps"))
              return
            }
            needsContinuation = true
            const assistantMessageID = yield* publisher.assistantMessageID(event.id)
            yield* Effect.uninterruptibleMask((restore) =>
              restore(
                toolMaterialization.settle({
                  sessionID: session.id,
                  agent: agent.id,
                  assistantMessageID,
                  call: event,
                }),
              ).pipe(
                Effect.flatMap((settlement) =>
                  publish(
                    LLMEvent.toolResult({
                      id: event.id,
                      name: event.name,
                      result: settlement.result,
                      output: settlement.output,
                    }),
                    settlement.outputPaths ?? [],
                  ),
                ),
              ),
            ).pipe(FiberSet.run(toolFibers))
          }),
        ),
        Effect.ensuring(withPublication(publisher.flush())),
      )

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const stream = yield* restore(providerStream).pipe(Effect.exit)
          const failure =
            stream._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(stream.cause)) : undefined
          if (
            recoverOverflow &&
            !publisher.hasAssistantStarted() &&
            isContextOverflowFailure(overflowFailure ?? failure) &&
            (yield* restore(recoverOverflow({ sessionID: session.id, entries, model, request })))
          )
            return yield* Effect.die(continueAfterOverflowCompaction(currentStep))
          if (overflowFailure) yield* publish(overflowFailure)
          const llmFailure = failure instanceof LLMError ? failure : undefined
          if (llmFailure && !publisher.hasProviderError()) {
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
            yield* withPublication(publisher.failAssistant(llmFailure.reason.message))
          }
          if (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) yield* FiberSet.clear(toolFibers)
          const settled = yield* restore(awaitToolFibers(toolFibers)).pipe(Effect.exit)
          if (settled._tag === "Failure" && isUserDeclined(settled.cause)) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            return yield* Effect.interrupt
          }
          if (
            (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) ||
            (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
          ) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            if (publisher.hasActiveAssistant())
              yield* withPublication(publisher.failAssistant("Provider turn interrupted"))
          }
          if (settled._tag === "Failure" && !Cause.hasInterrupts(settled.cause)) {
            const failure = Cause.squash(settled.cause)
            const message = failure instanceof Error ? failure.message : String(failure)
            yield* withPublication(publisher.failUnsettledTools(`Tool execution failed: ${message}`))
          }
          const stepSettlement = publisher.stepSettlement()
          if (stepSettlement && !publisher.hasProviderError()) {
            const endSnapshot = yield* snapshots.capture()
            const files =
              startSnapshot && endSnapshot
                ? yield* snapshots
                    .files({ from: startSnapshot, to: endSnapshot })
                    .pipe(Effect.catch(() => Effect.succeed(undefined)))
                : undefined
            yield* withPublication(
              events.publish(SessionEvent.Step.Ended, {
                sessionID: session.id,
                timestamp: yield* DateTime.now,
                assistantMessageID: yield* publisher.startAssistant(),
                finish: stepSettlement.finish,
                cost: 0,
                tokens: stepSettlement.tokens,
                snapshot: endSnapshot,
                files,
              }),
            )
          }
          if (publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
          if (stream._tag === "Success" && !publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
          if (stream._tag === "Failure") return yield* Effect.failCause(stream.cause)
          if (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
            return yield* Effect.failCause(settled.cause)
          return {
            needsContinuation: !publisher.hasProviderError() && needsContinuation,
            step: currentStep,
            failed: publisher.hasProviderError(),
            resultMessageID: publisher.hasAssistantStarted() ? yield* publisher.startAssistant() : undefined,
          }
        }),
      )
    }, Effect.scoped)
    type RunTurn = (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      onPromoted: (inputs: ReadonlyArray<SessionInput.Admitted>) => void,
    ) => Effect.Effect<
      {
        readonly needsContinuation: boolean
        readonly step: number
        readonly failed: boolean
        readonly resultMessageID?: SessionMessage.ID
      },
      RunError
    >

    const runAfterOverflowCompaction: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step, onPromoted) {
      return yield* runTurnAttempt(sessionID, promotion, step, onPromoted).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* Effect.die("Post-compaction provider attempt cannot recover another overflow")
            yield* Effect.yieldNow
            return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step, onPromoted)
          }),
        ),
      )
    })

    const runTurn: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step, onPromoted) {
      return yield* runTurnAttempt(sessionID, promotion, step, onPromoted, compaction.compactAfterOverflow).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            yield* Effect.yieldNow
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step, onPromoted)
            return yield* runTurn(sessionID, undefined, defect.transition.step, onPromoted)
          }),
        ),
      )
    })

    const run = Effect.fn("SessionRunner.run")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force: boolean
      readonly taskInputID?: string
    }) {
      const hasSteer = yield* SessionInput.hasPending(db, input.sessionID, "steer")
      const hasQueue = hasSteer ? false : yield* SessionInput.hasPending(db, input.sessionID, "queue")
      if (!input.force && !hasSteer && !hasQueue) return
      yield* failInterruptedTools(input.sessionID)
      let promotion: SessionInput.Delivery | undefined = hasSteer ? "steer" : hasQueue ? "queue" : undefined
      let shouldRun = input.force || hasSteer || hasQueue
      while (shouldRun) {
        const promoted = new Set<SessionInput.Admitted["id"]>()
        let failed = false
        let resultMessageID: SessionMessage.ID | undefined
        const logicalTurn = Effect.gen(function* () {
          let needsContinuation = true
          let step = 1
          while (needsContinuation) {
            const result = yield* runTurn(input.sessionID, promotion, step, (inputs) => {
              for (const admitted of inputs) promoted.add(admitted.id)
            })
            failed ||= result.failed
            resultMessageID = result.resultMessageID ?? resultMessageID
            needsContinuation = result.needsContinuation
            step = result.step + 1
            promotion = "steer"
            if (!needsContinuation) needsContinuation = yield* SessionInput.hasPending(db, input.sessionID, "steer")
          }
        }).pipe(
          Effect.onExit((exit) => {
            if (promoted.size === 0) return Effect.void
            const outcome = Exit.isSuccess(exit)
              ? failed
                ? ("failed" as const)
                : ("completed" as const)
              : Cause.hasInterrupts(exit.cause)
                ? ("cancelled" as const)
                : ("failed" as const)
            return Effect.gen(function* () {
              yield* SessionTurn.settle(db, events, {
                sessionID: input.sessionID,
                messageIDs: Array.from(promoted),
                outcome,
              })
              if (input.taskInputID && promoted.has(SessionMessage.ID.make(input.taskInputID)))
                yield* SessionTask.settle(db, events, {
                  inputID: input.taskInputID,
                  childSessionID: input.sessionID,
                  outcome,
                  resultMessageID,
                })
            })
          }),
        )
        yield* logicalTurn
        if (promoted.size > 0)
          yield* generateTitle(input.sessionID).pipe(
            Effect.catchCause((cause) => Effect.logError("failed to generate title", { error: Cause.squash(cause) })),
          )
        if (input.taskInputID) return
        shouldRun = yield* SessionInput.hasPending(db, input.sessionID, "queue")
        promotion = shouldRun ? "queue" : undefined
      }
    })

    return Service.of({
      run,
      compactManual,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    ExecutionPolicy.node,
    EventV2.node,
    llmClient,
    AgentV2.node,
    ToolRegistry.node,
    SessionRunnerModel.node,
    SessionStore.node,
    Location.node,
    RuntimeContext.node,
    RuntimeContextBuiltIns.node,
    Config.node,
    Snapshot.node,
    Database.node,
  ],
})

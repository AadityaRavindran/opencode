import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  Message,
  SystemPart,
  ToolFailure,
  isContextOverflowFailure,
  type ProviderErrorEvent,
} from "@opencode-ai/llm"
import { eq } from "drizzle-orm"
import { Cause, DateTime, Duration, Effect, FiberSet, Layer, Option, Schema, Semaphore, Stream } from "effect"
import { AgentV2 } from "../../agent"
import { Config } from "../../config"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { Location } from "../../location"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { QuestionV2 } from "../../question"
import { SystemContext } from "../../system-context/index"
import { SystemContextRegistry } from "../../system-context/registry"
import { SkillGuidance } from "../../skill/guidance"
import { ReferenceGuidance } from "../../reference/guidance"
import { ToolRegistry } from "../../tool/registry"
import { Tool } from "../../tool/tool"
import { ToolOutputStore } from "../../tool-output-store"
import { SessionContextEpoch } from "../context-epoch"
import { SessionCompaction } from "../compaction"
import { SessionEvent } from "../event"
import { SessionHistory } from "../history"
import { SessionInput } from "../input"
import { SessionMessage } from "../message"
import { Prompt } from "../prompt"
import { SessionSchema } from "../schema"
import { SessionTable } from "../sql"
import { SessionStore } from "../store"
import { type RunError, Service } from "./index"
import { SessionRunnerModel } from "./model"
import { createLLMEventPublisher } from "./publish-llm-event"
import { toLLMMessages } from "./to-llm-message"
import { MAX_STEPS_PROMPT } from "./max-steps"
import { Snapshot } from "../../snapshot"
import { makeLocationNode } from "../../effect/app-node"
import { llmClient } from "../../effect/app-node-platform"
import { SessionV1 } from "../../v1/session"
import { Slug } from "../../util/slug"
import { InstallationVersion } from "../../installation/version"
import { toV1Ruleset } from "../../permission/legacy"

const RECURSIVE_RECENT_MESSAGES = 12
const RECURSIVE_CONTEXT_MAX_ENTRIES = 500
const RECURSIVE_CONTEXT_MAX_TEXT = 4000
const RAH_MAX_DEPTH = 2
const RAH_MAX_CHILDREN = 6
const RAH_MAX_PROMPT_CHARS = 12_000
const RAH_TASK_TIMEOUT = Duration.minutes(30)
const RECURSIVE_RLM_SYSTEM = `Recursive RLM mode is enabled for this session.
Older session context is available through context_search, context_read, and context_recent. Do not rely on memory for old details. Query external context before answering questions about earlier work, decisions, files, failures, or long-running session state.`
const RECURSIVE_RAH_SYSTEM = `Recursive Agent Harness mode is enabled for this session.
For complex work, decompose the request into explicit smaller investigations or implementation slices before acting. Use the todo tool when available to track multi-step recursive work: create concise actionable items, keep exactly one item in progress, mark items complete as soon as they are verified, and add follow-up items for blockers or discoveries. Use available task or subagent tools for independent subtasks when they are present, but keep fanout bounded: at most 6 direct subtasks per session, depth at most 2, and no background subtasks. Reconcile subtask results into one coherent answer or implementation plan, and avoid todos or subtasks for simple local edits.`

type HistoryEntry = { readonly seq: number; readonly message: SessionMessage.Message }
type RecursiveContextEntry = { readonly seq: number; readonly type: SessionMessage.Type; readonly text: string }

function recursiveContextEntries(entries: readonly HistoryEntry[]) {
  return entries.slice(-RECURSIVE_CONTEXT_MAX_ENTRIES).map((entry) => ({
    seq: entry.seq,
    type: entry.message.type,
    text: truncate(messageText(entry.message).replace(/\s+/g, " ").trim(), RECURSIVE_CONTEXT_MAX_TEXT),
  }))
}

function recursiveContextTools(entries: readonly RecursiveContextEntry[]) {
  const format = (entry: RecursiveContextEntry) =>
    [`seq=${entry.seq}`, `type=${entry.type}`, truncate(entry.text, 1200)].join("\n")

  return {
    context_search: Tool.make({
      description: "Search older external session context. Returns matching message sequence numbers and excerpts.",
      input: Schema.Struct({
        query: Schema.String,
        limit: Schema.Number.pipe(Schema.optional),
      }),
      output: Schema.String,
      execute: (input) =>
        Effect.sync(() => {
          const query = input.query.trim().toLowerCase()
          if (!query) return "No query provided."
          const limit = Math.min(Math.max(input.limit ?? 10, 1), 50)
          const matches = entries
            .filter((entry) => entry.text.toLowerCase().includes(query))
            .slice(-limit)
          if (matches.length === 0) return "No matches."
          return matches.map(format).join("\n\n---\n\n")
        }),
    }),
    context_read: Tool.make({
      description: "Read external session context by message sequence number.",
      input: Schema.Struct({
        seq: Schema.Number,
      }),
      output: Schema.String,
      execute: (input) =>
        Effect.sync(() => {
          const match = entries.find((entry) => entry.seq === input.seq)
          if (!match) return `No message found for seq=${input.seq}.`
          return format(match)
        }),
    }),
    context_recent: Tool.make({
      description: "Read recent external session context outside the visible working set.",
      input: Schema.Struct({
        limit: Schema.Number.pipe(Schema.optional),
      }),
      output: Schema.String,
      execute: (input) =>
        Effect.sync(() => {
          const limit = Math.min(Math.max(input.limit ?? RECURSIVE_RECENT_MESSAGES, 1), 50)
          const matches = entries
            .slice(-limit)
            .map(format)
            .join("\n\n---\n\n")
          return matches || "No external context."
        }),
    }),
  }
}

function messageText(message: SessionMessage.Message): string {
  switch (message.type) {
    case "agent-switched":
      return `Agent switched: ${message.agent}`
    case "model-switched":
      return `Model switched: ${message.model.providerID}/${message.model.id}`
    case "user":
      return message.text
    case "synthetic":
      return message.text
    case "system":
      return message.text
    case "shell":
      return `Shell command: ${message.command}\n${message.output}`
    case "assistant":
      return message.content.map(assistantContentText).filter(Boolean).join("\n")
    case "compaction":
      return `${message.summary}\n${message.recent}`
  }
}

function assistantContentText(content: SessionMessage.AssistantContent): string {
  if (content.type === "text" || content.type === "reasoning") return content.text
  if (content.state.status === "pending") return `Tool: ${content.name}\n${JSON.stringify(content.state.input)}`
  const toolOutput = content.state.content
    .map((item) => (item.type === "text" ? item.text : item.type === "file" ? item.name ?? item.mime : ""))
    .filter(Boolean)
    .join("\n")
  return [`Tool: ${content.name}`, toolOutput].filter(Boolean).join("\n")
}

function truncate(value: string, length: number) {
  if (value.length <= length) return value
  return value.slice(0, length) + "\n[truncated]"
}

function recursiveStrategy(session: SessionSchema.Info) {
  if (session.recursive?.enabled !== true) return undefined
  return session.recursive.strategy ?? "hybrid"
}

function usesRecursiveContextTools(strategy: ReturnType<typeof recursiveStrategy>) {
  return strategy === "rlm" || strategy === "hybrid"
}

function usesRecursiveAgentHarness(strategy: ReturnType<typeof recursiveStrategy>) {
  return strategy === "rah" || strategy === "hybrid"
}

function taskOutput(input: {
  readonly sessionID: SessionSchema.ID
  readonly state: "completed" | "error"
  readonly text: string
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [`<task id="${input.sessionID}" state="${input.state}">`, `<${tag}>`, input.text, `</${tag}>`, "</task>"].join(
    "\n",
  )
}

function delegateTaskPermission(parent: SessionSchema.Info, childAgent: AgentV2.Info): SessionSchema.Info["permission"] {
  const inherited = (parent.permission ?? []).filter(
    (rule) => rule.action === "external_directory" || rule.effect === "deny",
  )
  const denies = [
    ...(childAgent.permissions.some((rule) => rule.action === "todowrite")
      ? []
      : [{ action: "todowrite" as const, resource: "*" as const, effect: "deny" as const }]),
    ...(childAgent.permissions.some((rule) => rule.action === "delegate_task")
      ? []
      : [{ action: "delegate_task" as const, resource: "*" as const, effect: "deny" as const }]),
  ]
  return [
    ...inherited,
    ...denies.filter(
      (deny) => !inherited.some((rule) => rule.action === deny.action && rule.resource === deny.resource),
    ),
  ]
}

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

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const llm = yield* LLMClient.Service
    const agents = yield* AgentV2.Service
    const tools = yield* ToolRegistry.Service
    const models = yield* SessionRunnerModel.Service
    const store = yield* SessionStore.Service
    const location = yield* Location.Service
    const systemContext = yield* SystemContextRegistry.Service
    const skillGuidance = yield* SkillGuidance.Service
    const referenceGuidance = yield* ReferenceGuidance.Service
    const config = yield* Config.Service
    const snapshots = yield* Snapshot.Service
    const db = (yield* Database.Service).db
    const compaction = SessionCompaction.make({ events, llm, config: yield* config.entries() })
    const getSession = Effect.fn("SessionRunner.getSession")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
      return session
    })

    const getContext = Effect.fn("SessionRunner.getContext")(function* (sessionID: SessionSchema.ID) {
      return yield* store.context(sessionID)
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

    // Match V1: dismissing a question halts the loop instead of becoming model-facing tool output.
    const isQuestionRejected = (cause: Cause.Cause<unknown>) =>
      cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect instanceof QuestionV2.RejectedError)

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

    const loadSystemContext = (agent: AgentV2.Selection) =>
      Effect.all([systemContext.load(), skillGuidance.load(agent), referenceGuidance.load()], {
        concurrency: "unbounded",
      }).pipe(Effect.map(SystemContext.combine))

    const childDepth = (session: SessionSchema.Info): Effect.Effect<number> =>
      Effect.gen(function* () {
        if (!session.parentID) return 0
        const parent = yield* store.get(session.parentID)
        if (!parent) return 0
        return 1 + (yield* childDepth(parent))
      })

    const createChildSession = Effect.fn("SessionRunner.delegateTask.createChild")(function* (input: {
      readonly parent: SessionSchema.Info
      readonly agent: AgentV2.Selection
      readonly title: string
      readonly permission: SessionSchema.Info["permission"]
    }) {
      const sessionID = SessionSchema.ID.create()
      const now = Date.now()
      const info = SessionV1.SessionInfo.make({
        id: sessionID,
        slug: Slug.create(),
        version: InstallationVersion,
        projectID: input.parent.projectID,
        directory: input.parent.location.directory,
        path: input.parent.subpath,
        workspaceID: input.parent.location.workspaceID,
        parentID: input.parent.id,
        title: input.title,
        agent: input.agent.id,
        model: input.agent.info?.model ?? input.parent.model,
        metadata: input.parent.recursive ? { recursive: input.parent.recursive } : undefined,
        permission: toV1Ruleset(input.permission),
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: now, updated: now },
      })
      yield* events.publish(SessionV1.Event.Created, { sessionID, info }, { location: input.parent.location })
      const child = yield* store.get(sessionID)
      if (!child) return yield* Effect.die(`Failed to create delegated task session: ${sessionID}`)
      return child
    })

    const delegateTaskTools = (parent: SessionSchema.Info, runChild: typeof run) => ({
      delegate_task: Tool.make({
        description:
          "Delegate one bounded foreground subtask to a subagent. Use for independent research or implementation slices in RAH mode. Do not use for trivial edits. Max depth 2 and max 6 direct child tasks are enforced.",
        input: Schema.Struct({
          description: Schema.String,
          prompt: Schema.String,
          subagent_type: Schema.String,
        }),
        output: Schema.String,
        execute: (input, context) =>
          Effect.gen(function* () {
            const depth = yield* childDepth(parent)
            if (depth >= RAH_MAX_DEPTH)
              return yield* Effect.fail(new ToolFailure({ message: `delegate_task exceeded max depth ${RAH_MAX_DEPTH}` }))
            if (input.prompt.length > RAH_MAX_PROMPT_CHARS)
              return yield* Effect.fail(
                new ToolFailure({ message: `delegate_task prompt exceeded ${RAH_MAX_PROMPT_CHARS} characters` }),
              )
            const directChildren = yield* db
              .select({ id: SessionTable.id, title: SessionTable.title })
              .from(SessionTable)
              .where(eq(SessionTable.parent_id, parent.id))
              .all()
              .pipe(Effect.orDie)
            if (directChildren.length >= RAH_MAX_CHILDREN)
              return yield* Effect.fail(
                new ToolFailure({ message: `delegate_task exceeded max children ${RAH_MAX_CHILDREN}` }),
              )
            if (directChildren.some((child) => child.title.startsWith(`${input.description} (`)))
              return yield* Effect.fail(
                new ToolFailure({ message: `delegate_task duplicate direct child task: ${input.description}` }),
              )
            const childAgent = yield* agents.select(input.subagent_type)
            if (!childAgent.info)
              return yield* Effect.fail(new ToolFailure({ message: `Unknown subagent: ${input.subagent_type}` }))
            if (childAgent.info.mode !== "subagent" && childAgent.info.mode !== "all")
              return yield* Effect.fail(
                new ToolFailure({ message: `Agent is not available as a subagent: ${input.subagent_type}` }),
              )
            const childPermission = delegateTaskPermission(parent, childAgent.info)
            const child = yield* createChildSession({
              parent,
              agent: childAgent,
              title: `${input.description} (@${childAgent.id} subagent)`,
              permission: childPermission,
            })
            yield* events.publish(SessionEvent.Task.Started, {
              sessionID: parent.id,
              timestamp: yield* DateTime.now,
              assistantMessageID: context.assistantMessageID,
              callID: context.toolCallID,
              taskSessionID: child.id,
              description: input.description,
              agent: childAgent.id,
            })
            yield* SessionInput.admit(db, events, {
              id: SessionMessage.ID.create(),
              sessionID: child.id,
              prompt: Prompt.fromUserMessage({ text: input.prompt }),
              delivery: "steer",
            })
            const result = yield* Effect.gen(function* () {
              yield* runChild({ sessionID: child.id, force: true })
              return (yield* store.context(child.id))
                .filter((message): message is SessionMessage.Assistant => message.type === "assistant")
                .flatMap((message) => message.content)
                .filter((content): content is SessionMessage.AssistantText => content.type === "text")
                .at(-1)?.text
            }).pipe(
              Effect.timeoutOrElse({
                duration: RAH_TASK_TIMEOUT,
                orElse: () => Effect.fail(new ToolFailure({ message: "delegate_task timed out after 30 minutes" })),
              }),
              Effect.exit,
            )
            if (result._tag === "Failure") {
              const failure = Cause.squash(result.cause)
              const message = failure instanceof Error ? failure.message : String(failure)
              yield* events.publish(SessionEvent.Task.Failed, {
                sessionID: parent.id,
                timestamp: yield* DateTime.now,
                assistantMessageID: context.assistantMessageID,
                callID: context.toolCallID,
                taskSessionID: child.id,
                error: { type: "unknown", message },
              })
              return yield* Effect.fail(new ToolFailure({ message }))
            }
            yield* events.publish(SessionEvent.Task.Completed, {
              sessionID: parent.id,
              timestamp: yield* DateTime.now,
              assistantMessageID: context.assistantMessageID,
              callID: context.toolCallID,
              taskSessionID: child.id,
            })
            return taskOutput({
              sessionID: child.id,
              state: "completed",
              text: result.value ?? "Task completed without text output.",
            })
          }),
      }),
    })

    const runTurnAttempt = Effect.fn("SessionRunner.runTurn")(function* (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      recoverOverflow?: typeof compaction.compactAfterOverflow,
    ) {
      const session = yield* getSession(sessionID)
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt
      const agent = yield* agents.select(session.agent)
      const initialized = yield* SessionContextEpoch.initialize(db, loadSystemContext(agent), session.id)
      const toolFibers = yield* FiberSet.make<void, ToolOutputStore.Error>()
      let needsContinuation = false
      let currentStep = step
      if (promotion) {
        const cutoff = yield* EventV2.latestSequence(db, session.id)
        let promoted = 0
        if (promotion === "steer") promoted = yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        if (promotion === "queue") {
          promoted += Number(yield* SessionInput.promoteNextQueued(db, events, session.id))
          promoted += yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        }
        if (promoted > 0) currentStep = 1
      }
      const system =
        initialized ?? (yield* SessionContextEpoch.prepare(db, events, loadSystemContext(agent), session.id))
      const model = yield* models.resolve(session)
      const entries = yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq)
      const recursive = recursiveStrategy(session)
      const recursiveContext = usesRecursiveContextTools(recursive)
      const recursiveTools = {
        ...(recursiveContext ? recursiveContextTools(recursiveContextEntries(entries.slice(0, -RECURSIVE_RECENT_MESSAGES))) : {}),
        ...(usesRecursiveAgentHarness(recursive) ? delegateTaskTools(session, run) : {}),
      }
      const context = (recursiveContext ? entries.slice(-RECURSIVE_RECENT_MESSAGES) : entries).map(
        (entry) => entry.message,
      )
      const isLastStep = agent.info?.steps !== undefined && currentStep >= agent.info.steps
      const toolMaterialization = isLastStep ? undefined : yield* tools.materialize(agent.info?.permissions, recursiveTools)
      const promptCacheKey = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id
      const request = LLM.request({
        model,
        providerOptions: { openai: { promptCacheKey } },
        system: [
          agent.info?.system,
          system.baseline,
          recursiveContext ? RECURSIVE_RLM_SYSTEM : undefined,
          usesRecursiveAgentHarness(recursive) ? RECURSIVE_RAH_SYSTEM : undefined,
        ]
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
          ...(session.model?.variant === undefined ? {} : { variant: session.model.variant }),
        },
        snapshot: startSnapshot,
      })
      const withPublication = Semaphore.makeUnsafe(1).withPermit
      const publish = (event: LLMEvent, outputPaths: ReadonlyArray<string> = []) =>
        withPublication(publisher.publish(event, outputPaths))
      let overflowFailure: ProviderErrorEvent | undefined
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
          if (settled._tag === "Failure" && isQuestionRejected(settled.cause)) {
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
          if (settled._tag === "Failure") return yield* Effect.failCause(settled.cause)
          return { needsContinuation: !publisher.hasProviderError() && needsContinuation, step: currentStep }
        }),
      )
    }, Effect.scoped)
    type RunTurn = (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
    ) => Effect.Effect<{ readonly needsContinuation: boolean; readonly step: number }, RunError>

    const runAfterOverflowCompaction: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step) {
      return yield* runTurnAttempt(sessionID, promotion, step).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* Effect.die("Post-compaction provider attempt cannot recover another overflow")
            yield* Effect.yieldNow
            return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step)
          }),
        ),
      )
    })

    const runTurn: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step) {
      return yield* runTurnAttempt(sessionID, promotion, step, compaction.compactAfterOverflow).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            yield* Effect.yieldNow
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step)
            return yield* runTurn(sessionID, undefined, defect.transition.step)
          }),
        ),
      )
    })

    const run = Effect.fn("SessionRunner.run")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force: boolean
    }) {
      const hasSteer = yield* SessionInput.hasPending(db, input.sessionID, "steer")
      const hasQueue = hasSteer ? false : yield* SessionInput.hasPending(db, input.sessionID, "queue")
      if (!input.force && !hasSteer && !hasQueue) return
      yield* failInterruptedTools(input.sessionID)
      let promotion: SessionInput.Delivery | undefined = hasSteer ? "steer" : hasQueue ? "queue" : undefined
      let shouldRun = input.force || hasSteer || hasQueue
      while (shouldRun) {
        let needsContinuation = true
        let step = 1
        while (needsContinuation) {
          const result = yield* runTurn(input.sessionID, promotion, step)
          needsContinuation = result.needsContinuation
          step = result.step + 1
          promotion = "steer"
          if (!needsContinuation) needsContinuation = yield* SessionInput.hasPending(db, input.sessionID, "steer")
        }
        shouldRun = yield* SessionInput.hasPending(db, input.sessionID, "queue")
        promotion = shouldRun ? "queue" : undefined
      }
    })

    return Service.of({
      run,
    })
  }),
)

export const defaultLayer = layer

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    EventV2.node,
    llmClient,
    AgentV2.node,
    ToolRegistry.node,
    SessionRunnerModel.node,
    SessionStore.node,
    Location.node,
    SystemContextRegistry.node,
    SkillGuidance.node,
    ReferenceGuidance.node,
    Config.node,
    Snapshot.node,
    Database.node,
  ],
})

import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { Model, Provider } from "@opencode-ai/sdk/v2"
import type { Session } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo } from "solid-js"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

type RecursiveMode = { readonly enabled: boolean; readonly strategy?: "rlm" | "rah" | "hybrid" }
type RecursiveSession = Session & { readonly recursive?: unknown; readonly metadata?: Record<string, unknown> }
type SelectedModelInfo = { readonly provider?: Provider; readonly model?: Model }

function recursiveFromUnknown(value: unknown): RecursiveMode | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const recursive = value as Record<string, unknown>
  if (typeof recursive.enabled !== "boolean") return undefined
  if (recursive.strategy !== "rlm" && recursive.strategy !== "rah" && recursive.strategy !== "hybrid") {
    return { enabled: recursive.enabled }
  }
  return { enabled: recursive.enabled, strategy: recursive.strategy }
}

function sessionRecursive(session: Session | undefined) {
  if (!session) return undefined
  const current = session as RecursiveSession
  return recursiveFromUnknown(current.recursive) ?? recursiveFromUnknown(current.metadata?.recursive)
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const cost = createMemo(() => session()?.cost ?? 0)
  const tasks = createMemo(() => props.api.state.session.list().filter((item) => item.parentID === props.session_id))
  const usage = createMemo(() => {
    if (!isChatGptModel(props.api)) return []
    const info = props.api.state.chatgpt
    if (info?.status !== "ok") return []
    return ["5h", "Weekly"].flatMap((label) => {
      const window = info.windows.find((item) => item.label.toLowerCase() === label.toLowerCase())
      if (!window) return []
      return `${label}: ${window.percent === undefined ? "?" : `${window.percent}%`} used${formatReset(window.resetAt, window.resetAfterSeconds)}`
    })
  })
  const recursive = createMemo(() => {
    const current = sessionRecursive(session())
    if (current?.enabled !== true) return "Off"
    return current.strategy ? `On (${current.strategy.toUpperCase()})` : "On"
  })

  const state = createMemo(() => {
    const last = msg().findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) {
      return {
        tokens: 0,
        percent: null,
      }
    }

    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    return {
      tokens,
      percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
    }
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      <text fg={theme().textMuted}>{state().tokens.toLocaleString()} tokens</text>
      <text fg={theme().textMuted}>{state().percent ?? 0}% used</text>
      <text fg={theme().textMuted}>Recursive: {recursive()}</text>
      <text fg={theme().textMuted}>Tasks: {tasks().length}</text>
      {usage().map((line) => (
        <text fg={theme().textMuted}>{line}</text>
      ))}
      {isCopilotModel(props.api) && <text fg={theme().textMuted}>{money.format(cost())} spent</text>}
    </box>
  )
}

function isChatGptModel(api: TuiPluginApi) {
  const info = selectedModelInfo(api)
  return [info.model?.providerID, info.provider?.id, info.provider?.name, info.model?.id, info.model?.api.id].some((value) => {
    const lower = value?.toLowerCase()
    return lower === "openai" || lower === "chatgpt" || lower?.startsWith("openai/") === true || lower?.includes("chatgpt") === true
  })
}

function isCopilotModel(api: TuiPluginApi) {
  const info = selectedModelInfo(api)
  return [info.model?.providerID, info.provider?.id, info.provider?.name, info.model?.api.npm].some((value) => {
    const lower = value?.toLowerCase()
    return lower === "github-copilot" || lower?.includes("copilot") === true
  })
}

function selectedModelInfo(api: TuiPluginApi): SelectedModelInfo {
  const model = api.state.model
  if (!model) return {}
  const provider = api.state.provider.find((item) => item.id === model.providerID)
  return { provider, model: provider?.models[model.modelID] }
}

function formatReset(resetAt: number | undefined, resetAfterSeconds: number | undefined) {
  if (resetAt) return `, resets ${new Date(resetAt * 1000).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}`
  if (resetAfterSeconds) return `, resets in ${formatDuration(resetAfterSeconds)}`
  return ""
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${Math.ceil(seconds)}s`
  if (seconds < 60 * 60) return `${Math.ceil(seconds / 60)}m`
  if (seconds < 24 * 60 * 60) return `${Math.ceil(seconds / (60 * 60))}h`
  return `${Math.ceil(seconds / (24 * 60 * 60))}d`
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin

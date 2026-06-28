import { Auth } from "."
import { Effect, Schema } from "effect"

export const UsageWindow = Schema.Struct({
  label: Schema.String,
  percent: Schema.optional(Schema.Finite),
  resetAt: Schema.optional(Schema.Finite),
  resetAfterSeconds: Schema.optional(Schema.Finite),
}).annotate({ identifier: "ChatGptUsageWindow" })
export type UsageWindow = typeof UsageWindow.Type

export const Info = Schema.Struct({
  status: Schema.Literals(["ok", "missing-auth", "error"]),
  plan: Schema.optional(Schema.String),
  windows: Schema.Array(UsageWindow),
  message: Schema.optional(Schema.String),
}).annotate({ identifier: "ChatGptUsage" })
export type Info = typeof Info.Type

const URL = "https://chatgpt.com/backend-api/wham/usage"

export const fetch = Effect.fn("ChatGptUsage.fetch")(function* () {
  const auth = yield* Auth.Service
  const info = yield* auth.get("openai")
  if (info?.type !== "oauth") {
    return Info.make({ status: "missing-auth", windows: [], message: "Run `opencode auth login openai` first." })
  }

  const current = info.access && info.expires > Date.now() ? info : yield* refresh(info)
  const response = yield* Effect.tryPromise({
    try: () =>
      globalThis.fetch(URL, {
        headers: {
          authorization: `Bearer ${current.access}`,
          ...(current.accountId && { "ChatGPT-Account-Id": current.accountId }),
        },
      }),
    catch: (cause) => new Error(`Failed to fetch ChatGPT usage: ${formatCause(cause)}`),
  })
  if (!response.ok) {
    return Info.make({ status: "error", windows: [], message: `ChatGPT usage request failed: HTTP ${response.status}` })
  }

  const payload = yield* Effect.tryPromise({
    try: () => response.json() as Promise<unknown>,
    catch: (cause) => new Error(`Failed to parse ChatGPT usage: ${formatCause(cause)}`),
  })
  return parse(payload)
})

function refresh(info: Auth.Oauth) {
  return Effect.tryPromise({
    try: async () => {
      const { extractAccountId, refreshAccessToken } = await import("../plugin/openai/codex")
      const tokens = await refreshAccessToken(info.refresh)
      return Auth.Oauth.make({
        type: "oauth",
        refresh: tokens.refresh_token,
        access: tokens.access_token,
        expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
        accountId: extractAccountId(tokens) ?? info.accountId,
      })
    },
    catch: (cause) => new Error(`Failed to refresh ChatGPT auth: ${formatCause(cause)}`),
  }).pipe(
    Effect.flatMap((next) =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("openai", next)
        return next
      }),
    ),
  )
}

export function parse(payload: unknown) {
  const root = readRecord(payload)
  if (!root) return Info.make({ status: "error", windows: [], message: "Unexpected ChatGPT usage response." })

  return Info.make({
    status: "ok",
    plan: readString(root.plan_type),
    windows: usageWindows(root),
  })
}

function usageWindows(root: Record<string, unknown>) {
  return [
    ...rateLimitWindows(readRecord(root.rate_limit)),
    ...(Array.isArray(root.additional_rate_limits)
      ? root.additional_rate_limits.flatMap((item) => {
          const details = readRecord(item)
          return rateLimitWindows(details && readRecord(details.rate_limit))
        })
      : []),
  ]
}

function rateLimitWindows(rateLimit: Record<string, unknown> | undefined) {
  if (!rateLimit) return []
  return [readRecord(rateLimit.primary_window), readRecord(rateLimit.secondary_window)]
    .map(usageWindow)
    .filter((window): window is UsageWindow => window !== undefined)
}

function usageWindow(window: Record<string, unknown> | undefined) {
  if (!window) return undefined
  return UsageWindow.make({
    label: windowLabel(readNumber(window.limit_window_seconds)),
    percent: readNumber(window.used_percent),
    resetAt: readNumber(window.reset_at),
    resetAfterSeconds: readNumber(window.reset_after_seconds),
  })
}

function windowLabel(seconds: number | undefined) {
  if (!seconds) return "Usage"
  const minutes = seconds / 60
  if (isApprox(minutes, 5 * 60)) return "5h"
  if (isApprox(minutes, 24 * 60)) return "Daily"
  if (isApprox(minutes, 7 * 24 * 60)) return "Weekly"
  if (isApprox(minutes, 30 * 24 * 60)) return "Monthly"
  if (isApprox(minutes, 365 * 24 * 60)) return "Annual"
  return "Usage"
}

function isApprox(value: number, expected: number) {
  return value >= expected * 0.95 && value <= expected * 1.05
}

function readRecord(value: unknown) {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

function readString(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function formatCause(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}

export * as ChatGptUsage from "./chatgpt-usage"

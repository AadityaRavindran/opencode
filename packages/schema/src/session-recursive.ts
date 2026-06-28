export * as SessionRecursive from "./session-recursive"

import { Schema } from "effect"
import { optional } from "./schema"

export const Strategy = Schema.Literals(["rlm", "rah", "hybrid"]).annotate({
  identifier: "Session.Recursive.Strategy",
})
export type Strategy = typeof Strategy.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  enabled: Schema.Boolean,
  strategy: Strategy.pipe(optional),
}).annotate({ identifier: "Session.Recursive.Info" })

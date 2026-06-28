import { Permission } from "@opencode-ai/schema/permission"
import { PermissionV1 } from "../v1/permission"

export function fromV1Ruleset(rules: PermissionV1.Ruleset | undefined): Permission.Ruleset | undefined {
  return rules?.map((rule) => ({ action: rule.permission, resource: rule.pattern, effect: rule.action }))
}

export function toV1Ruleset(rules: Permission.Ruleset | undefined): PermissionV1.Ruleset | undefined {
  return rules?.map((rule) => ({ permission: rule.action, pattern: rule.resource, action: rule.effect }))
}

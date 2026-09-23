export * as ExecutionPolicy from "./policy"

import path from "node:path"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Permission } from "@opencode-ai/schema/permission"
import { SessionPolicy } from "@opencode-ai/schema/session-policy"
import { AgentV2 } from "../agent"
import { Config } from "../config"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { Reference } from "../reference"
import { SkillPackageAccess } from "../skill/package-access"
import { SessionPolicyAccess } from "../session/policy-access"
import { SessionPolicyStore } from "../session/policy"
import { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"
import { Wildcard } from "../util/wildcard"

export interface Snapshot {
  readonly agentRules: Permission.Ruleset
  readonly rules: Permission.Ruleset
  readonly ceilings: SessionPolicy.Boundary
  readonly session: SessionPolicyStore.View
}

export function evaluate(action: string, resource: string, rules: Permission.Ruleset) {
  return (
    rules.findLast((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource))?.effect ??
    "ask"
  )
}

export function denied(snapshot: Snapshot, action: string, resource: string) {
  return (
    evaluate(action, resource, snapshot.rules) === "deny" ||
    snapshot.ceilings.some((rules) => evaluate(action, resource, rules) === "deny")
  )
}

export function whollyDisabled(snapshot: Snapshot, action: string) {
  return [snapshot.rules, ...snapshot.ceilings].some((rules) => {
    const rule = rules.findLast((item) => Wildcard.match(action, item.action))
    return rule?.resource === "*" && rule.effect === "deny"
  })
}

export interface Interface {
  readonly resolve: (
    sessionID: SessionSchema.ID,
    agentID?: string,
  ) => Effect.Effect<Snapshot, SessionPolicyStore.Failure>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/ExecutionPolicy") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const policies = yield* SessionPolicyAccess.Service
    const database = yield* Database.Service
    const agents = yield* AgentV2.Service
    const location = yield* Location.Service
    const packages = yield* SkillPackageAccess.Service
    const references = yield* Reference.Service
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    return Service.of({
      resolve: Effect.fn("ExecutionPolicy.resolve")(function* (sessionID, agentID) {
        const session = yield* policies.inspect(sessionID)
        if (
          SessionPolicyStore.locationKey(session.location) !==
          SessionPolicyStore.locationKey(Location.Ref.make(location))
        )
          return yield* new SessionPolicyStore.Failure({
            kind: "conflict",
            message: "Permission Location does not own this Session",
          })
        const stored = yield* database.db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!stored)
          return yield* new SessionPolicyStore.Failure({ kind: "not-found", message: "Session does not exist" })
        const agent = yield* agents.resolve(agentID ?? stored.agent ?? undefined)
        if (!agent) {
          const rules = [{ action: "*", resource: "*", effect: "deny" as const }]
          return { session, rules, agentRules: rules, ceilings: [] }
        }
        const parts = yield* agents.permissionLayers(agent)
        const origins = new Map<string, Config.Document["filesystem"]>()
        for (const entry of yield* config.entries()) {
          if (entry.type !== "document") continue
          for (const name of Object.keys(entry.info.references ?? {})) origins.set(name, entry.filesystem)
        }
        const dirs = (yield* references.list()).filter(
          (entry) =>
            location.target.type === "local" || (origins.get(entry.name) === "target" && entry.source.type === "local"),
        )
        const verified = yield* Effect.forEach(dirs, (entry) => fs.resolve(entry.path).pipe(Effect.option), {
          concurrency: 4,
        })
        const roots = [
          ...(yield* packages.paths(sessionID)),
          ...verified.flatMap((entry) => (Option.isSome(entry) ? [entry.value] : [])),
        ]
        const paths = location.target.type === "rexd" ? path.posix : path
        // Literal glob metacharacters must never expand a package grant to siblings.
        const defaults: Permission.Ruleset = roots
          .filter((root) => !/[?*]/.test(root))
          .flatMap((root) => [
            { action: "external_directory", resource: root, effect: "allow" as const },
            { action: "external_directory", resource: paths.join(root, "*"), effect: "allow" as const },
          ])
        const boundary =
          stored.permission_boundary === null
            ? undefined
            : Schema.decodeUnknownOption(SessionPolicy.Boundary)(stored.permission_boundary)
        if (boundary && Option.isNone(boundary))
          return yield* new SessionPolicyStore.Failure({
            kind: "unavailable",
            message: "Parent permission boundary is unreadable",
          })
        const inherited =
          boundary && Option.isSome(boundary)
            ? boundary.value
            : stored.parent_id
              ? [SessionPolicyStore.legacyRules(stored.permission).filter((rule) => rule.effect === "deny")]
              : []
        return {
          session,
          agentRules: [...parts.defaults, ...parts.configured],
          rules: [...parts.defaults, ...defaults, ...parts.configured, ...session.rules],
          ceilings: [...inherited, ...(stored.parent_id ? [agent.permissions] : [])],
        }
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    SessionPolicyAccess.node,
    Database.node,
    AgentV2.node,
    Location.node,
    SkillPackageAccess.node,
    Reference.node,
    Config.node,
    FSUtil.locationNode,
  ],
})

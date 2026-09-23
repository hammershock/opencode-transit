export * as ConfigExperimental from "./experimental"

import { Schema } from "effect"
import { Catalog } from "../catalog"
import { Policy as PolicyV2 } from "../policy"

// Each core domain exports the policy actions it supports. Adding an action to
// this union makes it valid in authored config while keeping Policy generic.
export const PolicyAction = Schema.Union([Catalog.PolicyActions])

export class Policy extends Schema.Class<Policy>("ConfigV2.Experimental.Policy")({
  ...PolicyV2.Info.fields,
  action: PolicyAction,
}) {}

export class Experimental extends Schema.Class<Experimental>("ConfigV2.Experimental")({
  policies: Policy.pipe(Schema.Array, Schema.optional),
  user_shell_cwd: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Keep User Shell cwd in memory for the current runtime (default: false)",
  }),
  location_env: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Load target-side user and project dotenv files for Location processes (default: false)",
  }),
  background_subagents: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Enable background subagents; when omitted, use the experimental environment flags",
  }),
  subagent_economics: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Provide device-local model economics to the parent Agent for subagent routing (default: false)",
  }),
}) {}

export function backgroundSubagents(config: { experimental?: { background_subagents?: boolean } }, fallback: boolean) {
  return config.experimental?.background_subagents ?? fallback
}

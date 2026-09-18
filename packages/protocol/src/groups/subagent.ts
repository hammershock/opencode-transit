import { Location } from "@opencode-ai/schema/location"
import { Subagent } from "@opencode-ai/schema/subagent"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"
import { SubagentMutationError } from "../errors"

const CatalogQuery = Schema.Struct({
  ...LocationQuery.fields,
  sessionID: Schema.String.pipe(Schema.optional),
  parentAgentID: Schema.String,
  includeInactive: Schema.Literals(["true", "false"]).pipe(Schema.optional),
}).annotate({ identifier: "Subagent.CatalogQuery" })

const mutation = { error: SubagentMutationError } as const

export const makeSubagentGroup = <LocationId extends HttpApiMiddleware.AnyId, LocationService>(
  locationMiddleware: Context.Key<LocationId, LocationService>,
) =>
  HttpApiGroup.make("server.subagent")
    .add(
      HttpApiEndpoint.get("subagent.catalog", "/api/subagent", {
        query: CatalogQuery,
        success: Location.response(Subagent.Snapshot),
      })
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.subagent.catalog", summary: "Resolve subagents" })),
    )
    .add(
      HttpApiEndpoint.post("subagent.definition.create", "/api/subagent/definition", {
        query: LocationQuery,
        payload: Subagent.DefinitionCreate,
        success: Location.response(Subagent.Snapshot),
        ...mutation,
      })
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({ identifier: "v2.subagent.definition.create", summary: "Create subagent" }),
        ),
    )
    .add(
      HttpApiEndpoint.patch("subagent.definition.update", "/api/subagent/definition/:subagentID", {
        params: { subagentID: Schema.String },
        query: LocationQuery,
        payload: Subagent.DefinitionUpdatePayload,
        success: Location.response(Subagent.Snapshot),
        ...mutation,
      })
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({ identifier: "v2.subagent.definition.update", summary: "Update subagent" }),
        ),
    )
    .add(
      HttpApiEndpoint.delete("subagent.definition.remove", "/api/subagent/definition/:subagentID", {
        params: { subagentID: Schema.String },
        query: LocationQuery,
        payload: Subagent.MutationContext,
        success: Location.response(Subagent.Snapshot),
        ...mutation,
      })
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({ identifier: "v2.subagent.definition.remove", summary: "Remove subagent" }),
        ),
    )
    .add(
      HttpApiEndpoint.patch("subagent.access.update", "/api/subagent/access", {
        query: LocationQuery,
        payload: Subagent.AccessUpdate,
        success: Location.response(Subagent.Snapshot),
        ...mutation,
      })
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({ identifier: "v2.subagent.access.update", summary: "Set subagent access" }),
        ),
    )
    .middleware(locationMiddleware)
    .annotateMerge(
      OpenApi.annotations({ title: "subagents", description: "Subagent definition and access workflows." }),
    )

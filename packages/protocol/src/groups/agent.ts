import { Agent } from "@opencode-ai/schema/agent"
import { Location } from "@opencode-ai/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const AgentGroup = HttpApiGroup.make("server.agent").add(
  HttpApiEndpoint.get("agent.list", "/api/agent", {
    query: LocationQuery,
    success: Location.response(Schema.Array(Agent.Info)),
  })
    .annotateMerge(locationQueryOpenApi)
    .annotateMerge(
      OpenApi.annotations({
        identifier: "v2.agent.list",
        summary: "List agents",
        description: "Retrieve currently registered agents.",
      }),
    ),
  HttpApiEndpoint.get("agent.catalog", "/api/agent/catalog", {
    query: LocationQuery,
    success: Location.response(Schema.Array(Agent.CatalogEntry)),
  })
    .annotateMerge(locationQueryOpenApi)
    .annotateMerge(
      OpenApi.annotations({
        identifier: "v2.agent.catalog",
        summary: "List current Agent management metadata",
        description:
          "Read current configured names and identities without reloading execution state or Session context.",
      }),
    ),
)

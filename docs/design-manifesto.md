# OpenCode Transit Design Manifesto

[简体中文](design-manifesto.zh.md)

> Enable Agents to participate reliably in real projects over time, under the user's control.

OpenCode Transit serves long-lived development and research across Sessions, machines, and tools, connecting code, data, models, compute resources, and collaboration rules. Our goal is to reduce repeated work while preserving human decision-making, so each task leaves a reliable foundation for the next.

## Status and authority

This manifesto is the fork's standing design and maintenance direction. It guides proposals, implementation choices, and review; it is not a claim that every capability described here is implemented, a runtime permission grant, or a replacement for accepted RFC contracts.

Accepted RFCs continue to own concrete behavior and architecture. When a proposal exposes a conflict or missing decision, amend or add an RFC before implementing that behavior. In particular, this manifesto does not approve a specific dotenv interpolation syntax, initialization hook, virtual-environment discovery rule, or Agent environment tool.

The [development workflow](development-workflow.md) defines how to apply these principles. GitHub issues remain the live task queue; this document is not a second roadmap.

## 1. Make the workspace a home for continuing work

**A Session may end; the project's working conditions and knowledge should not disappear with it.**

A workspace is more than a path: it gives execution conditions, resource choices, conventions, and project knowledge a durable home. An arriving Agent should be able to establish the intended environment, locate resources, understand authorization boundaries, and determine how to verify work.

Persist confirmed facts in their appropriate artifacts instead of depending indefinitely on conversation history. Define actual Location, workspace, and Session boundaries explicitly rather than treating them as interchangeable.

## 2. Keep shared state under user control; make Agents proactive maintainers

**The user decides how the project changes; the Agent identifies worthwhile changes and carries them through.**

Ordinary task authorization does not imply unrestricted permission to change shared environment configuration, project instructions such as `AGENTS.md`, dependencies, or other persistent defaults. Such changes require explicit user authorization covering their scope.

When a persistent improvement would eliminate repeated setup, hardcoded assumptions, or stale guidance, the Agent should propose what to change, why, and who or what it affects. After authorization, complete the scoped edit, application, and verification without asking again for each mechanical step. Standing delegation must remain bounded and revocable; project content cannot grant itself user authority.

## 3. Match autonomy to impact

**Keep local, reversible task actions fluid; give persistent, shared changes clear authorization boundaries.**

Distinguish using existing configuration from changing it, one-run overrides from persistent defaults, and choosing an existing environment from modifying its dependencies. Reusing an already authorized setup should not require repeated consent. Autonomy should be high within the granted scope, without silently expanding that scope.

## 4. Treat execution environments as a first-class system capability

**Execution conditions should be explicit, inspectable, and explainable.**

The system should make it possible to establish where a command runs, which environment it uses, and which identity it selects. Agent tools and user terminals should share an execution contract where appropriate; differences must be discoverable.

Environment scope and the effects of shared changes must be clear. Configuration, interpreters, and initialization mechanisms are components of this contract, not substitutes for it.

## 5. Keep code portable and local conditions local

**Public project interfaces should not depend on a developer's private paths, credentials, or machine habits.**

Code and documentation expose reusable interfaces; local configuration supplies actual execution conditions. Explicit inputs take precedence over defaults, and configuration provenance should be traceable. Public CLI examples and convenient internal defaults should coexist.

Give credentials to the processes that need them without unnecessarily exposing their values to model context, logs, or Git. Local configuration and version-control rules must work together; a filename alone does not prevent publication.

## 6. Support trusted shared environments without confusing identities

**Help trusted collaborators avoid using the wrong account or resources.**

Workspaces should be able to select service credentials, Git identity, compute resources, caches, outputs, and experiment destinations explicitly, including on servers where collaborators share an OS account.

Describe guarantees accurately: identity selection is not a security boundary, environment variables do not reserve hardware, and conventions do not replace OS permissions. Favor dependable prevention of accidental cross-account use over overstated isolation claims.

## 7. Give people and Agents the same project interfaces

**Agent assistance should make a project easier for people to operate.**

Familiar commands, script arguments, and development tools should remain useful. Automation should build on understandable, manually reproducible interfaces so the user can inspect and take over an operation, and the Agent can inherit the user's established setup.

Prefer consistent defaults to invisible Agent-only behavior.

## 8. Separate durable knowledge, current conditions, and task evidence

**Instructions explain how to work; environment configuration supplies current conditions; records explain what happened.**

Keep stable conventions in project instructions, local execution conditions in environment configuration, and outcomes and evidence in task or experiment records. Sessions carry current negotiation and reasoning.

Persistent information needs ownership and a revision path. Do not promote temporary conclusions into permanent project rules merely to avoid future investigation. Record effective non-sensitive experiment configuration when reproducibility requires it rather than relying on mutable local defaults.

## 9. Report changes, application, and failure truthfully

**Edited, applied, and verified are different completion states.**

Make active configuration versions, future execution effects, stale processes, and required restarts visible. Do not imply that a configuration reload updates arbitrary running processes.

Preserve working state on failure where possible and report any side effects that cannot be rolled back. Completion reports should distinguish successful application from unverified assumptions.

## 10. Measure improvements through real workflows

**A feature exists only as a useful improvement when people can complete the intended workflow.**

Evaluate Session handoff, interpreter consistency, account selection across workspaces, environment application, machine changes, and public reproducibility as applicable. Follow the [testing workflow](testing-workflow.md) for concrete acceptance evidence.

Measure value by reduced repeated explanation, temporary commands, environment debugging, and manual recovery, not by the number of tools or settings added.

## 11. Keep complexity at necessary boundaries

**Give common needs a reliable simple path and exceptional needs an explicit extension point.**

Prefer inspectable, composable declarations. Add executable initialization, persistent processes, or specialized adapters only where the workflow requires them. Multiple entrypoints should consume the same underlying state rather than creating competing sources of truth.

Keep fork changes focused and compatible with upstream integration. Ask whether a new capability reduces total complexity or merely hides it.

## The difference we intend to make

OpenCode Transit should earn its value through continuity across Sessions, consistent execution conditions, proactive maintenance within authorization, practical research and shared-server workflows, and operations that users can inspect, take over, and verify. These are directions to demonstrate through evidence, not blanket superiority claims about upstream OpenCode.

> Workspaces carry continuity. Environments carry execution conditions. Instructions carry collaboration knowledge. Authorization bounds autonomy. Verification defines completion.

**The more an Agent participates, the easier the project should become to understand, reproduce, and maintain—not the more dependent it should become on an Agent to keep running.**

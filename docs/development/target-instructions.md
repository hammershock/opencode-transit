# Target-specific instructions

OpenCode Transit can apply controller-owned rules to every Session that uses one target. This layer is useful for durable
execution and safety constraints that are broader than a project but should not affect unrelated targets.

## Placement and precedence

Create the optional file on the controller that runs OpenCode Transit:

- local target: `<user-config>/targets/local/AGENTS.md`
- Rexd target: `<user-config>/targets/<TargetID>/AGENTS.md`

`<user-config>` is the active OpenCode user configuration directory. `<TargetID>` is the local ID of the target definition,
not its display name. Do not copy the file to the target user's home directory: target-specific instructions are controller
configuration and are read only through the controller filesystem.

Instructions are admitted in this order:

1. controller-global `AGENTS.md` and global configured instructions;
2. controller-owned target `AGENTS.md`;
3. Location project and working-directory rules plus project configured instructions, followed by nested rules discovered later.

The model context and `/context` inspector identify the middle layer as `<target-config>/AGENTS.md`. The durable context does
not contain the controller path or TargetID.

## Standing constraints and Skills

Use target instructions for constraints that should remain true throughout work on the target: ownership boundaries, shared
node etiquette, resource inspection requirements, cache/output policy, and authorization boundaries. Keep step-by-step
procedures, reusable diagnostics, and task-specific workflows in Skills. Skill visibility and activation are independent of
target instructions.

The [generic shared accelerator template](../examples/huawei-target-AGENTS.md) is a sanitized starting point. Adapt only the
stable policy; keep current host inventory, personal paths, secret locations, account names, and endpoints out of the file.

## Applying changes

Target instructions use the existing model-context lifecycle. A new Session admits the current file. An existing Session keeps
its frozen copy across ordinary turns, process restart, Session re-entry, transparent reconnect, and Skill activation. Apply an
intentional edit through an existing successful `/init` refresh or Location rebind boundary. The replacement is durable and
syncs as part of the Session context; a receiving device uses the accepted body instead of reading its own target sidecar.

If the optional file is absent, behavior is unchanged. If it exists but cannot be read, context establishment continues and
`/context` reports a sanitized ignored-source diagnostic. There is no fallback to target HOME or the Location filesystem.

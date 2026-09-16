# Harness instructions

OpenCode Transit can admit controller-owned global and target rules before Location-owned project rules. Target rules are
useful for durable execution and safety constraints that belong to a machine, cluster, or shared service rather than one
project. One rule file may be shared by several targets.

## Device-local settings and precedence

Instruction bindings belong to the controller device in `<user-config>/harness.jsonc`. They are not target-registry fields,
do not sync between controllers, and are never discovered from target HOME. The version 1 shape is:

```jsonc
{
  "version": 1,
  "instructions": {
    // Omit to preserve default global AGENTS.md / CLAUDE.md discovery.
    "global": "policies/global.md",
    "targets": {
      "local": "policies/local.md",
      "00000000-0000-4000-8000-000000000000": "policies/shared-accelerator.md",
    },
  },
}
```

Relative references resolve from `<user-config>`. Absolute references and `~/...` references resolve on the controller with
the controller's HOME. A configured missing or unreadable file is diagnosed explicitly; it never falls back to another rule.
An unset global binding keeps the existing `<user-config>/AGENTS.md`, then `~/.claude/CLAUDE.md`, fallback. An unset target
binding means that target has no controller-owned target rule.

Instructions are admitted in this order:

1. the default or custom controller-global rule, followed by global configured instructions;
2. the controller-owned rule bound to the current target, when set;
3. Location project and working-directory rules, followed by project configured instructions and nested rules discovered
   later.

The settings service uses revision-checked atomic writes so concurrent managers cannot silently overwrite each other. It can
list settings, inspect and validate references, reset global discovery, and bind or unbind targets without deleting a shared
rule file. Runtime and durable context identify custom files as `<global-instructions>` and `<target-instructions>`; controller
absolute paths, target IDs, and device-local sharing details are not persisted into portable Session context.

## Standing constraints and Skills

Use harness instructions for constraints that should remain true throughout work on the target: owned-path-only operations on
shared nodes, shared-state authorization boundaries, local identity selection, live GPU and storage inspection before
expensive work, cache/output placement, and bounded or background jobs. Keep reusable procedures, task sequences, and
diagnostic playbooks in Skills. Skill visibility and activation remain independent of instruction bindings.

The [generic shared accelerator template](../examples/huawei-target-AGENTS.md) is a sanitized public starting point. Public
examples must omit volatile inventory, personal paths, secret locations, account names, and endpoints. A private target policy
may contain stable paths, local identity conventions, and account-selection rules that its owner intentionally needs; secret
values still never belong in instruction files.

## Lifecycle

A new Session admits the files resolved at context initialization. Saving a binding or editing a referenced file affects
future admission only: an existing Session keeps its frozen copy across ordinary turns, process restart, Session re-entry,
transparent reconnect, and Skill activation. Existing successful context refresh and Location rebind boundaries reread the
current bindings and establish one replacement durable generation. Location rebind also reevaluates the target binding for the
new Location.

The admitted instruction bodies sync as part of Session context. A receiving device uses that accepted generation instead of
consulting its own device-local bindings. `/context` displays the admitted state and sanitized diagnostics; it does not expose
controller paths or reconfigure bindings.

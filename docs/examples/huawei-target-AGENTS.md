# Shared accelerator target rules

This target is a shared compute environment. Treat these rules as standing constraints; use Skills for procedural workflows.

## Ownership and authorization

- Read, create, modify, and delete only paths owned by the current user or explicitly assigned to the current project.
- Do not change shared accounts, system configuration, global credentials, shared credential stores, mounts, network settings,
  schedulers, services, or another user's processes without explicit authorization for that exact shared-state change.
- Select the intended local user, project, or billing identity explicitly. Do not infer authority from credentials or sessions
  that happen to be available on the node.

## Resource checks

- Inspect live accelerator availability, memory pressure, storage capacity, quota, and relevant running jobs before expensive
  downloads, preprocessing, training, rendering, or evaluation.
- Start with a bounded probe that validates the environment, inputs, output location, and expected resource use.
- Re-check live state when a queued or delayed job actually starts; do not rely on inventory captured in documentation.

## Data, caches, and outputs

- Put caches, temporary data, checkpoints, logs, and final outputs only in project-owned or explicitly designated storage.
- Keep large transient artifacts out of home directories and shared system locations unless the target policy explicitly assigns
  those locations for that purpose.
- Never expose secrets in commands, logs, process arguments, committed files, or generated artifacts.

## Job lifecycle

- Give long-running work explicit resource and time bounds. Run it through the target's approved scheduler or a recoverable
  background mechanism, and record the job identifier, logs, outputs, and cleanup responsibility.
- Do not monopolize shared accelerators or storage, and do not stop, reprioritize, or replace another user's job.
- Confirm outputs and checkpoints are durable before cleaning temporary files. Shared-state cleanup requires the same explicit
  authorization as shared-state creation or mutation.

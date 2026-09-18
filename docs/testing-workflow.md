# Fork Testing Workflow

Verification in this fork is proportional to impact and risk. A narrow low-risk change may be accepted with focused tests that directly exercise the changed behavior. Broader changes still require the package, contract, integration, real-device, and multi-device evidence selected below because Location, SSH/Rexd, TUI input, secure storage, provider authentication, persistent data, and synchronization can depend on real operating-system behavior. Fork-owned TUI checks also follow [`ui-design-guidelines.md`](ui-design-guidelines.md).

## Focused fast path

Use the focused fast path when the diff is narrow, its behavior and failure mode are well understood, it does not create a material migration or data-loss risk, and focused tests cover the changed boundary. Document why the scope is low risk and list the exact checks run.

For this fork (`origin` / `hammershock/opencode-transit`), once those focused tests pass and the PR is open, the change may merge without waiting for review or queued CI. Do not claim unawaited checks passed. Build and transactionally install on the Mac from a clean exact post-merge `dev` commit, then verify the installed version and manifest, macOS signature when applicable, and a proportional smoke test. A later regression is handled through a follow-up issue/PR.

Do not use this fast path when the change's actual risk requires wider evidence, including incompatible public-contract changes, migrations, credentials or authorization, persistent-data integrity, synchronization or deletion semantics, release automation, or affected platform-specific behavior. Remote execution and TUI changes may still qualify when the patch is tightly bounded and a focused contract test or harmless real-target probe resolves the relevant risk; otherwise run the broader rows below. This authorization applies only to the fork and never permits writes to `upstream`.

## Platform selection: Mac by default

Outside the focused fast path, routine platform-neutral logic, tool lifecycle, and TUI changes require a clean Mac candidate build, focused automated checks, and the affected real workflow through `opencode-transit`. Windows/WSL2 is not a mandatory second device for every task. Its temporary unavailability alone does not block a platform-neutral change, and a Mac pass must never be reported as Windows evidence.

Add coverage according to the changed boundary:

- Cross-device synchronization, deletion propagation, conflict resolution and device identity require actual multi-device scenarios, including bidirectional checks where specified below.
- Windows/WSL-specific paths, case handling, shell/PTY/interop, credential stores, packaging and native dependencies require that platform's evidence.
- Shared platform-dependent changes require extra-platform checks when Mac evidence and deterministic contract tests cannot resolve the compatibility risk. Generic asynchronous logic is not automatically Windows-specific.
- Remote-target checks are selected independently of Windows availability. Changed transport, handshake, installation or target-side behavior needs relevant real-target evidence when controlled adapter tests cannot establish correctness. Explain when a controller-only fix is sufficiently covered by Mac execution and adapter regressions.
- A release qualifies each platform artifact it actually ships; do not infer a Windows release result from a Mac build.

Record required and optional scenarios in the issue/PR. A known failure on an affected platform does not become optional because a device is unavailable. Any maintainer-approved deferral of a required scenario must explicitly name the risk and follow-up; it is not a passing test or release qualification.

This policy supersedes older blanket two-device wording in maintenance checklists and RFC verification boilerplate. Genuine synchronization and platform-specific acceptance contracts remain required. Broaden regression testing for affected milestones or new evidence of risk, not for every unrelated maintenance change.

### Contributor and maintainer responsibility

The verification gate belongs to the project, not to an external contributor's hardware inventory.

- External contributors run the relevant automated checks and real workflow on every supported controller they can access. Their pull request lists exact results and every platform or scenario not run.
- Missing access to Mac Apple Silicon or `mywindows`/WSL2 does not block opening or reviewing an external pull request.
- Before a non-fast-path functional change merges, the accepting maintainer builds the exact candidate commit and completes missing risk-selected required rows or records an explicit scoped deferral. For a focused fast-path change, the maintainer instead builds and installs the clean exact post-merge integration commit on the Mac and records that evidence.
- Documentation-only and template-only changes normally use rendering, link, schema, and formatting checks instead of runtime device acceptance.

Optional unrun Windows coverage is not an outstanding mandatory gate for an otherwise verified platform-neutral change. Required checks and explicit maintainer dispositions remain visible in the PR.

## Risk-selected test ladder

Select the necessary levels for the changed boundary and run selected checks in this order. A focused fast-path change may stop after the smallest level that directly establishes its behavior and failure path:

1. **Static checks:** formatting or lint checks required by the affected package, generated-file checks and package-local `bun typecheck`.
2. **Unit tests:** parsers, state transitions, reducers, cryptographic envelopes, conflict rules and failure classification.
3. **Contract tests:** boundaries between Core, Location providers, Rexd protocol, command toolkit, provider adapters and sync adapters.
4. **Integration tests:** real process/database/filesystem behavior in temporary isolated state, including cancellation, crash recovery and retries.
5. **Real-device acceptance:** execute the built `opencode-transit` on Mac and any additional risk-selected devices.
6. **Milestone regression:** run the relevant wider matrix for the affected milestone and platform artifacts, including cross-device cases when applicable.

A lower test layer does not replace a real workflow when the affected boundary or issue contract requires one. A Mac-only task does not owe a synthetic Windows check merely to mark Windows optional. A Windows or synchronization defect still requires corresponding evidence or a documented maintainer disposition.

## Canonical devices and entrypoint

All fork acceptance uses the command name:

```text
opencode-transit
```

Do not replace or overwrite the upstream `opencode` command. Installation transactionally replaces the existing `opencode-transit` build after validating the candidate and maintains the temporary `opencode-rexd` compatibility launcher required by RFC-0013.

Canonical environments:

| Device      | Environment                               | Required invocation boundary                                                                                                                                                      |
| ----------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mac         | macOS on Apple Silicon                    | Run the locally built/installed `opencode-transit` directly                                                                                                                       |
| `mywindows` | WSL2 distribution `Ubuntu`, user `hammer` | Connect with `ssh mywindows`, then explicitly invoke `wsl.exe -d Ubuntu -u hammer`; set a Linux HOME/cwd explicitly and never inherit `/mnt/c/Users/Mickey` as the test workspace |

Record the actual hostname, OS/architecture, Git commit, executable path, `--version` output and executable hash for every real-device run. When several devices are selected, they must test the same candidate commit; platform artifacts may differ.

For required pre-merge Mac acceptance, prepare an isolated clean checkout at the exact PR head and run `bun run script/transit-build.ts --single --skip-install` from `packages/opencode`. For a focused fast-path change, perform this build after merge from an isolated clean checkout at the exact `dev` integration commit. Verify the manifest and use the transactional installer in [`development/opencode-transit.md`](development/opencode-transit.md). Record PR-head and post-merge integration builds distinctly. For required paired builds use `opencode-transit-dual-build --pr <number-or-url>`; without arguments it builds latest `origin/dev`. Failure preparing an optional WSL device does not prevent native Mac-only qualification.

## Isolation and data safety

- Use a unique temporary test workspace, target label and Session title prefix for each run.
- Never run destructive cases against personal workspaces, production Session IDs or an unscoped cloud directory.
- Tests that remove a target definition must first preserve the exact test fixture and restore it after the scenario. They must not alter unrelated Rexd targets.
- Tests must never print or persist SSH keys, OAuth tokens, recovery keys, `.env` secret values, provider credentials or decrypted sync payloads in logs or screenshots.
- Real credential and secure-storage tests assert presence, identity and behavior through redacted diagnostics; they do not snapshot secret values.
- Clean up test Sessions through product/domain deletion so tombstone behavior is exercised. Filesystem cleanup is allowed only for isolated test artifacts after state has been verified.
- Existing Rexd connection configuration is durable test infrastructure and must not be purged with Session data.

## Task-level real-device gate

Every non-fast-path functional task names the relevant rows and platform-selection rationale. After automated checks pass, run the exact candidate through `opencode-transit` on Mac and required additional devices. A focused fast-path task instead records why focused coverage is sufficient and performs the clean post-merge Mac build/install verification described above. Isolated candidate acceptance need not overwrite a production installation; record final installation separately.

Minimum evidence:

```md
## Real-device acceptance

Commit:
Build/version/hash:

### Platform selection

- Changed platform/transport boundaries:
- Required devices and scenarios:
- Optional/not-run platforms and rationale:

### Mac

- Environment and target:
- Scenarios:
- Result:
- Redacted log/artifact path:

### mywindows / WSL2

- Required or optional for this change:
- Environment and target:
- Scenarios:
- Result:
- Redacted log/artifact path:

### Cleanup

- Test Sessions deleted globally:
- Temporary targets/workspaces removed or restored:
- Previous binary restored if required:
```

Screenshots or recordings are mandatory for TUI-visible behavior. Logs are mandatory for protocol, retry, fallback, sync and deletion behavior. Evidence may be attached to the PR rather than committed to the repository when it contains machine-specific metadata.

## Real-device matrix

### A. Local Location

Run on Mac by default; add WSL2 when selected for the affected behavior:

- QuickStart selects local and an explicit working directory rather than inheriting the launcher cwd.
- Agent filesystem/process tools, User Shell and Terminal resolve the same Session Location.
- User Shell cwd continuity follows RFC-0004 during the process and disappears after restart.
- completion works without leaking helper startup state into execution.
- bare shell execution receives the RFC-0005 layered EnvironmentSnapshot.

### B. Rexd remote Location

For required real-target cases, run Mac to a configured Linux Rexd target. Add `mywindows` when Windows/WSL bridging is affected, not solely because a feature supports remote targets:

- target wizard/import, validation and directory completion operate on the target;
- managed daemon installation and protocol/capability handshake report each failure phase;
- Agent tools, User Shell, files, mutations and Terminal PTY operate remotely;
- cancellation, disconnect and reconnect respect side-effect/retry rules;
- no connection or capability failure falls back to Mac-local execution.

### C. Environment and Shell

- target base environment is detected on the actual target, not the control device;
- target user `.env`, project `.env` and explicit process environment apply in the specified order;
- `/env list`, reload and init obey masking and transaction rules;
- Terminal restart/stale behavior is visible after reload;
- shell startup files do not run for normal commands;
- local and Rexd User Shell execution use the same bounded one-shot contract; a deliberately blocked command is cancelled at the boundary, preserves cwd, and directs interactive work to Terminal;
- Backspace and Escape behavior, completion, cwd and Agent isolation match RFC-0004 and RFC-0008.

### D. Target recovery and rebind

- removing an isolated target definition makes all referencing test Sessions unresolved and read-only;
- cloud portable target name is a hint only and never auto-selects a connection;
- restoring the original target ID recovers the batch while independently invalid directories remain unresolved;
- portable-label binding works independently on each device;
- force rebind changes only the selected Session and does not modify other Sessions, the registry or label bindings.

### E. Command toolkit and overrides

- external/upstream commands keep upstream resolution and execution behavior;
- every override setting off yields the unmodified upstream handler;
- setting on and compatible installs the decorator;
- runtime installation failure preserves upstream behavior and emits the required warning;
- a synthetic upstream contract drift fails typecheck/build rather than waiting for runtime.

### F. Provider usage

- adapters only receive credentials already managed by the active OpenCode provider connection;
- browser, provider CLI and external application login state are not discovered;
- adapter timeout, schema drift or authentication failure does not block model use;
- usage data never enters Session history, durable Agent context, export or sync payload; RFC-0014's explicitly enabled controller-local, one-shot subagent routing guidance is the only Agent-context exception and must disappear after the next parent continuation.

### G. Multi-device Session sync

Before designing or changing a cloud-provider adapter, qualify the real account against a dedicated, exact test prefix. This is a release prerequisite, not evidence that mocks or documentation may replace. Record sanitized requests, provider codes and observed visibility latency for: missing singleton and batched metadata; absent-only create; unknown create outcome; mutable replacement; paginated recursive listing; metadata-to-download consistency; missing-object deletion; and immediate read-after-write/read-after-replace behavior. Repeat the probe from both supported devices when their HTTP stacks or credential stores differ. Do not attribute a failed product scenario to the provider until this probe reproduces it independently of Core sync state.

Run bidirectionally between Mac and `mywindows`:

- the TUI completes the product-owned Baidu OAuth flow without requesting AppKey, SecretKey or an external login state;
- OAuth completion leaves automatic sync disabled and offers `Enable and sync now`, `Enable` and `Keep disabled`;
- the fixed account-wide manifest is the only initialization fact; missing or incompatible manifests never accept uploads;
- explicit initialization backfills every existing Session, and every future Session participates without assignment or a user-visible space;
- disabling automatic sync stops queue consumption while durable outbox events continue to accumulate and later resume from checkpoints;
- `/sessions` keeps its device-local Path and Target filters stable while delayed cloud metadata is discovered;
- initial metadata appears before lazy content hydration;
- each device can create and append while the other is offline, then converge deterministically;
- attachments and large tool payloads hydrate, verify and retry independently;
- target ID, SSH configuration, credentials, `.env` values, OpenCode configuration and UI/runtime state never upload;
- v1 payloads use the specified plaintext codec and the UI does not expose encryption or recovery-key concepts;
- an unbound portable target remains unresolved until the device-local wizard binds it;
- sibling conflict results are identical under reversed pull order;
- production setup does not discover or migrate the archived prototype login. A separate explicit test fixture may reuse its exact secure-store identity to test compatibility without exposing the credential.

### H. Global deletion non-resurrection

Run the scenario in both directions, once with Mac deleting and once with `mywindows` deleting:

1. Device A deletes a synced Session.
2. Device B remains offline with old heads, materialized content and a pending old mutation/outbox.
3. Device A uploads the deletion marker and freezes the required device-ID set.
4. Device B reconnects and pulls the deletion. Interrupt it before its replacement head is uploaded; verify no acknowledgement exists and cloud payload is retained.
5. Resume B: it deletes local state, publishes a head without the Session, then publishes its idempotent acknowledgement.
6. Trigger garbage-collection eligibility, restart and repeat projection rebuild.
7. Verify neither device nor a newly connected device recreates the Session; after every required device has acknowledged or been revoked, its payload, attachment, marker and acknowledgements are gone.

This is a release-blocking regression. Payload garbage collection may occur only after acknowledgements whose corresponding replacement heads are already durable. Any resurrection is a correctness and data-loss-class failure; do not ship or merge around it.

For account-wide cloud reset, verify the manifest is invalidated before object cleanup. An interrupted cleanup may leave orphan objects, but another device must treat the root as uninitialized, pause automatic sync and request an explicit decision. Reinitialization clears those orphans before publishing a new manifest; cancellation disables automatic sync.

### I. TUI interaction

- QuickStart production prompt reaches a focused first paint, echoes sustained keyboard input within a bounded automated deadline, and keeps global keymap commands dispatchable;
- `Shift+Up` and `Shift+Down` move through declared variants without wrapping;
- `Ctrl+T` retains upstream cycle behavior;
- autocomplete and modal focus take priority over variant shortcuts;
- Backspace on empty User Shell input does not exit; Escape does;
- slash command panels and warning/fallback states render without entering model context.
- fork Core commands resolve to the same identity and availability from slash autocomplete, direct submit and `Ctrl+P`.
- User Shell and path completion share the eight-row candidate interaction; accepting a candidate never submits or executes.
- `/permissions` distinguishes device Default from durable Session mode; changing either leaves the other unchanged, and old Sessions open in normal mode.
- `/sessions` keeps search separate from the independent Path and Target rows; `Tab` changes row focus and left/right changes only the focused value. Apply both filters to the deduplicated local-plus-cloud candidate set across projects; verify all four combinations, exact normalized Cwd matching, persisted values, delayed metadata, and discovery of another project's local Session without cloud metadata.
- list statuses use the shared symbols, remain right-aligned as asynchronous state changes, expose long errors only in focused detail and contain no emoji.
- v1 sync setup and management are present only in the TUI; Web/Desktop retain upstream behavior and expose no partial sync product flow.

## Legacy prototypes

The archived implementations are evidence and prototypes, not an implementation baseline. Tests may reuse their scenarios, fixtures after sanitization, protocol lessons and reproduced failures. Production code must follow the accepted RFCs and current package contracts; do not cherry-pick a legacy feature wholesale.

In particular, preserve regression coverage for the legacy sync resurrection failures, TUI-owned remote execution, persisted Shell cwd and control-device `.env` resolution. The archived forced-encryption and login-reuse product flows are not compatibility requirements: plaintext is now the default space codec, and the exact old secure-store identity is allowed only in explicit compatibility tests. A new implementation passes only when old resurrection and cross-scope failure modes are structurally impossible or covered by a failing test.

## Merge and release rules

- A focused fast-path PR may merge after its focused tests pass without waiting for queued CI or pre-merge Mac evidence; record the skipped wait and add clean post-merge Mac build/install evidence.
- Other PRs cannot be marked Done until Mac evidence and required extra-device evidence or explicit scoped maintainer dispositions are recorded.
- A known failure on an affected platform remains unresolved even if Mac passes; optional unrun Windows coverage is not itself a failure.
- Flaky real-device behavior is a defect to diagnose, not a passing retry.
- A milestone release requires the relevant matrix for included behavior and shipped artifacts; synchronization milestones retain bidirectional tests.
- Record cleanup and the intended installed build on every device actually updated. An untouched Windows installation must not be reported updated.

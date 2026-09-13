# Wi v0.2 Milestone 11 implementation report

## Identity and scope

- Candidate: uncommitted working tree on `feat/milestone-11-provider-connections`
- Milestone 11 base: `f4d7a56a4281664466e5411f403b6be93dbccdc8`
- Scope: provider connection identity/catalog, file and environment credential stores, lifecycle/recovery, explicit routing, immutable run snapshots, browser management, and fake/no-network evidence only
- Excluded: OpenAI requests, endpoint probes, OAuth, provider WebSocket transport, automatic routing, keyring, app-server fallback, real tools/plugins, Windows, and Milestone 12 behavior

## Implemented invariants

- Provider connections are durable nonsecret catalog records with isolated identity, auth mode, generation, lifecycle revision, capabilities, and explicit status. A transactional hard maximum of 1,000 rows keeps the complete safe inventory bounded; exact selection uses direct connection lookup and never depends on list ordering/truncation.
- All catalog-global commands share one command-ID namespace across `catalog_commands`, provider lifecycle operations, and provider metadata operations. Symmetric transactional checks make session creation/provider lifecycle/provider metadata reuse conflict in either ordering, while concurrent claims yield one owner. Provider lifecycle commands also have one exclusive per-connection owner. Catalog-only disable commits ownership admission, lifecycle cutoff, disabled projection, durable result, and owner clearance in one catalog transaction.
- File effects commit through durable `prepared`, `file_observed`, and terminal phases before acknowledgement. The credential store now exposes generic hooks immediately after final credential rename and after credential unlink, before containing-directory fsync; the stage provisioner exposes the analogous post-rename/pre-staging-directory-fsync hook. Server/fixture composition maps these to closed test-only failpoints 114–116 without importing server types into `@wi/credentials`.
- Exact envelope/binding evidence plus canonical identity and constant-time bounded secret comparison makes replacement and deletion retries idempotent without accepting or mutating mismatched files.
- File create/replace/delete and recovery survive named real-process crash windows without duplicate generations, effects, or credential files. Restart recognizes an exact already-published reserved target before consulting staging evidence, so create, replace, refresh, and reauthenticate complete safely when the claimed stage disappeared after the file effect; readable stages still undergo claim and secret-material comparison.
- Credential roots are validated before mutation, honor `XDG_STATE_HOME`, remain outside `WI_HOME`, and reject unsupported/Windows-backed mounts. Bounded mountinfo parsing decodes Linux octal path escapes including newline before longest-mount selection, so unsafe nested mounts cannot hide behind escaped names. First-use CLI provisioning prospectively canonicalizes an absent `WI_HOME` without creating catalog or session state. Crash-left semantic-probe files are boundedly reconciled only after strict descriptor verification; unsafe strict matches fail closed and unrelated lookalikes remain untouched.
- Staged API keys enter through backend-local input bounded on raw bytes and decoded by one streaming UTF-8 decoder so split multibyte code points remain exact. Distinct commands racing for one staged source produce one owner and one durable `credential.provisioning_already_claimed` loser in catalog admission; the loser creates no connection/effect and replays identically after winner cleanup. They expire and are cleaned immediately after terminal success or pre-effect failure, with bounded startup retry for interrupted cleanup. Cleanup requires exact `0600` before reading an expired stage and has a real-process unlink-before-directory-flush crash boundary. Initial claim persists only bounded nonsecret descriptor identity (device, inode, size, high-resolution ctime) from the same no-follow stage read; every post-prepare/restart read requires that identity plus provisioning ID, provider, and auth mode before key use, without persisting a credential-derived hash. Strict generated pre-rename credential and stage temporaries are also validated and removed during startup. Generated credential/stage reads use nonblocking no-follow descriptor validation so FIFOs and other nonregular files fail without waiting.
- Recovery admits durably before consuming a process-bound reference, closes root membership plus complete secret-bearing envelope evidence before discovery, repeats complete closure before claim, and verifies the claimed evidence again before restore. Scanner bindings retain only canonical nonsecret metadata plus keyed process-local fingerprints, never complete credential strings; exact epoch timers clear service results/bindings and zero fingerprint/key buffers even without a later request. A successful claim detaches an independently owned keyed verifier that survives public epoch cleanup through catalog reservation and final file verification, then explicitly disposes/zeroizes on every success or failure path. Secret evidence never enters safe results. The final no-follow claim read also persists only bounded nonsecret descriptor identity (device, inode, size, high-resolution ctime) in the internal lifecycle row, with no credential-derived hash; restart requires that identity plus exact envelope binding, so secret-only source replacement tombstones rather than rebinds. Authoritative identity claims are restored only when workspace presence is explicit `none` or a concrete value; `unknown` workspace remains nonclaimable for uniqueness. Recovery exposes aggregate-bounded reconciliation status. New ingress cannot register after epoch closure; after observing closure and drained ingress, status repeats the durable lifecycle/metadata lookup before making `not_accepted` final, so a stale initial absence cannot hide already-registered terminal work. A durable recovery-active marker allows all retained envelopes to be recovered across restarts before the recovery window closes. Claimed source changes create an unavailable tombstone; explicit staged replacement binds a fresh internal reference and preserves any retained changed evidence. Process-local recovery bindings synchronously enter `claiming` before their first asynchronous rescan, so exactly one concurrent command can consume a reference and losers persist the already-claimed taxonomy. Occupied original connection identity, authoritative identity ownership, and evidence claimed by another command produce distinct stable `credential.recovery_connection_conflict`, `credential.recovery_identity_conflict`, and `credential.recovery_already_claimed` results across rejection, retry, and status.
- Browser recovery persistence contains no command envelope, recovery reference, generated filename, internal credential reference, path, or secret. Process-bound recovery candidates are removed from component memory immediately after submission, at expiry, and on terminal reconciliation. Real browser/process tests preserve the safe journal across backend death at validating, prepared, file-observed, and terminal-before-ack boundaries and reconcile the same command identity exactly once after reload. Browser provisioning guidance exposes only the supported backend-local CLI commands and tells the user to paste the returned `provref_…`; it advertises no HTTP claim endpoint. Catalog and recovery-status polling is single-flight with two-second admission intervals, five-second attempt deadlines, late-result suppression, unmount cancellation, and exactly-once terminal notices.
- Run snapshot acceptance holds a per-connection lease from final authoritative selection validation through the session acceptance commit. Lifecycle cutoffs share that boundary and wait for earlier acceptance; final revalidation rejects a run if disable committed during preliminary capability resolution, before any message or run projection is stored. Success and rejection both release the lease.
- Every selected-provider request acquires a connection/generation/revision-bound lease. File requests verify the exact envelope; environment requests rematch the in-memory fingerprint. The lease issues the key only through a request-scoped adapter-context callback and is reacquired after tool results.
- Environment credentials enforce the shared 16,384-byte UTF-8 API-key limit before acceptance fingerprinting and on every request re-read before hashing or issuance. Oversized values return typed `credential.environment_invalid`, mark the matching connection unavailable, and never reach the adapter callback. Failed run acceptance and every terminal run outcome release provisional environment state. Backend restart interrupts accepted environment-backed work before any new provider request.
- Session defaults require the exact capability version, and accepted runs immutably snapshot explicit routing, connection, credential generation, process epoch, capability/model/tool/reasoning/transport, and provider chain identity. Durable command identity is checked before live provider validation, so an exact retry returns its original result after connection state changes.
- Restart recovery gives every nonterminal lifecycle operation an explicit outcome; an absent target is terminalized transactionally with owner removal, claim consumption, and stage cleanup. A missing or mismatched replacement stage restores old generation/readiness only when exact old-envelope evidence proves no file effect; ambiguous evidence stays unavailable.
- Post-commit capability publication and recovery-availability refresh cannot reject durable success; failures are logged redacted and retained for startup/list-triggered repair.
- Provider-chain compatibility uses canonical full-snapshot equality, with an independent property oracle varying every pinned affinity field.
- Provider-service shutdown stops admission and drains lifecycle tasks, recovery scans/status reads, the fixed process-wide recovery-ingress budget (64 frames/512 KiB), locks, and request leases before clearing process state or allowing storage shutdown. Recovery ingress reserves count and bounded raw/canonical command bytes synchronously, charges duplicates independently, rejects saturation before serialized routing, and releases each reservation exactly once.
- Provider failure diagnostics use the adapter selected by the durable run snapshot rather than the composed fallback provider.
- The built credential CLI has real Linux process-boundary proof that descriptor input is absent from `/proc` command arguments, controlled shell history, stdout/stderr diagnostics, and `WI_HOME`.
- Normal composition remains deterministic and no-network; connection-aware provider behavior is available only through the test-gated fixture.

## Main change areas

- `packages/protocol/`: provider IDs, safe views, commands, events, run snapshots, recovery status schemas, and error codes.
- `packages/provider-connections/`: authoritative identity, exclusive lifecycle, affinity, and explicit router logic.
- `packages/credentials/`: roots, envelopes, atomic file store, environment fingerprints, provisioning, final-scan recovery, and tests.
- `packages/storage/`: catalog v6/session v5 migrations, provider repository/RPC operations, lifecycle evidence, recovery admission/claims, capabilities, provider defaults, and immutable run snapshots.
- `packages/harness-core/`: asynchronous run snapshotting, rejection cleanup, restored environment-run interruption, and provider-aware run execution.
- `apps/server/`: composition, provider connection service and `recovery-ingress` budget, credential CLI, explicit browser-safe projections, metadata-bound authenticated reads/status, failpoints, leases, and startup recovery/cleanup.
- `apps/web/`: safe connection API, identity-disambiguated operation/default selectors, complete M11 operation panel, explicit defaults, and bounded recovery reconciliation journal.
- `tests/`: integration, property/fuzz, frozen independent prior-schema migration and rollback, real-process crash/restart, secret/no-network, multi-tab, and browser E2E coverage.
- `docs/`: migrations, security, operational limits, browser protocol, known limitations, remediation ledger, and this report.

## Verification evidence

| Command | Result |
| --- | --- |
| Focused round-27 remediation gate | claimed-verifier lifetime/zeroization plus aggregate recovery ingress: 4 files, 123 tests passed |
| Provider lifecycle process suite | 56 tests passed |
| `pnpm check` | 99 files, 1,130 tests passed; 10 package entry points verified |
| `pnpm test:e2e` | 43 passed, including recovery process-death reloads, lifecycle-owner conflict/closure convergence, run pinning, no fallback, session/model synchronization, and file lifecycle |
| `pnpm test:fuzz` | `WI_FC_SEED=737373` and `WI_FC_SEED=737374` invocations passed; each reported 11 files, 43 tests, including the full affinity mutation oracle |
| `git diff --check` | passed |
| Default `${XDG_STATE_HOME:-$HOME/.local/state}/wi/credentials` inspection | zero files |

The Vitest workspace uses one thread per project for the normal full gate so the SQLite/property/process suites do not exhaust shared CI capacity and produce false timeout failures. Timed fuzz profiles retain parallel property execution and their bounded elapsed-time behavior.

## Remaining release steps and risks

- The candidate is intentionally uncommitted and has not been pushed.
- `prompts/` remains a local workflow tree and must not be staged.
- A twenty-ninth fresh independent implementation review must validate this exact corrected tree.
- Only after independent local PASS may the exact reviewed tree proceed through commit, exact-head CI, remote approval, merge-tree and post-merge attestations.
- Milestone 12 remains unauthorized until those release gates pass.
- M11 proves no-network fixture semantics; it does not prove any live provider transport, authentication exchange, billing identity, or OpenAI behavior.

## Round-27 remediation evidence

- `WI-M11-R27-H1` is implemented with an independently owned `ClaimedCredentialVerifier`. Public recovery-epoch close still invalidates unused references and clears scanner bindings, but a consumed claim carries only cloned keyed fingerprint evidence through reservation and final file observation. The verifier is idempotently disposed and zeroized on success and every failure path; it retains no credential string and writes no sensitive material to SQLite, browser payloads, logs, diagnostics, errors, or command results. Unchanged evidence crossing epoch expiry restores the original connection/generation once through `prepared` → `file_observed` → terminal success; changed evidence retains the existing consumed-claim `credential.recovery_source_changed` unavailable tombstone path.
- `WI-M11-R27-M1` is implemented with one process-wide admission budget of 64 pending recovery frames and 512 KiB of raw/canonical command-byte charge. Reservations happen synchronously before ingress-map insertion, duplicate keys consume independent reservations, exact releases are idempotent, BrowserConnection rejects saturation before serialized routing with typed `provider.rate_limited`, and direct service routing uses the same budget. Shutdown closes new admission and drains only bounded reserved ingress.
- Deterministic regressions: `packages/credentials/src/recovery.test.ts` proves post-close unchanged/changed verification and verifier disposal; `tests/integration/provider-connection-runtime.test.ts` gates after claim/reservation and after `file_observed`, expires/replaces the public epoch, and proves one ready original generation plus stable retry; `apps/server/src/provider-connections/recovery-ingress.test.ts` covers exact count/byte boundaries and release behavior; `tests/integration/milestone5-server.test.ts` covers duplicate reservations, two authenticated WebSockets, saturation without a lifecycle row/effect, direct-route non-bypass, release, and shutdown drain.

## Final round-27 gate evidence

| Command | Result |
| --- | --- |
| `pnpm lint` | Passed |
| `pnpm typecheck` | Passed |
| Focused round-27 tests | 4 files, 123 tests passed |
| `pnpm check` | 99 files, 1,130 tests passed |
| `pnpm test:e2e` | 43 passed |
| `WI_FC_SEED=737373 pnpm test:fuzz` | Passed; 11 files, 43 tests |
| `WI_FC_SEED=737374 pnpm test:fuzz` | Passed; 11 files, 43 tests |
| `git diff --check` | Passed |
| Default `${XDG_STATE_HOME:-$HOME/.local/state}/wi/credentials` root | 0 entries |

A twenty-ninth fresh independent review is required. This record does not self-approve Milestone 11, clear release, or authorize Milestone 12.

## Round-28 crash-boundary remediation evidence

- `WI-M11-R28-M1` is remediated with generic `@wi/credentials` hooks at post-credential-rename/pre-directory-fsync, post-credential-unlink/pre-directory-fsync, and post-stage-rename/pre-staging-directory-fsync.
- The closed provider failpoints are `after_provider_credential_rename_before_flush` (exit 114), `after_provider_credential_unlink_before_flush` (exit 115), and `after_provider_stage_rename_before_flush` (exit 116). They require the existing `NODE_ENV=test` and `WI_ALLOW_TEST_FAILPOINTS=1` gates plus a validated provider-command selector and force abrupt process exit through the existing controller.
- Real-child regressions use the same credential/catalog/staging roots across restart. Create and replace reconcile exact old/new complete envelopes without a second publish or generation increment; logout and delete reconcile exact absence/old evidence into distinct terminal projections; stage publication proves no returned reference or secret output and cleans an unclaimed complete stage or absence without a claim or connection.
- The process assertions observe the pre-restart namespace, require parseable complete credential files only, assert final file count/binding/generation/owner/claim state, perform exact retries, and scan `WI_HOME` plus child output for synthetic secrets.

| Command | Result |
| --- | --- |
| `pnpm lint` | Passed |
| `pnpm typecheck` | Passed |
| Focused credential unit/hooks | 3 files, 37 tests passed |
| Focused crash-window process regressions | 6 tests passed |
| Complete provider lifecycle process suite | 1 file, 66 tests passed |
| `pnpm check` | Passed; 100 files, 1,142 tests |
| `pnpm test:e2e` | 43 passed |
| `WI_FC_SEED=737373 pnpm test:fuzz` | Passed; 11 files, 43 tests per round |
| `WI_FC_SEED=737374 pnpm test:fuzz` | Passed; 11 files, 43 tests per round |
| `git diff --check` | Passed |
| Default `${XDG_STATE_HOME:-$HOME/.local/state}/wi/credentials` root | 0 entries |

A twenty-ninth fresh independent review is required; this evidence does not self-approve Milestone 11 or authorize Milestone 12.

## WI-M11-H1 environment revalidation correction

The remote review found that an environment-backed connection could become `unavailable` without any accepted operation to restore the same connection after its variable became valid. The old traces left both an initially absent connection and a post-use invalidated connection unavailable. The deterministic pre-fix assertions were `Expected lifecycleStatus: "ready"; Received lifecycleStatus: "unavailable"` and `provider.connection_unavailable` before credential resolution.

The correction adds `providerConnection.environment.revalidate` as a strict backend-only command. The command contains only `commandId`, `connectionId`, expected lifecycle revision, and expected generation. The service validates the existing environment reference without exposing the value, then admits the existing connection through the durable `enable` lifecycle kind. A successful commit changes only `unavailable` to `ready`, increments lifecycle revision once, preserves connection ID, generation, identity, capabilities, and defaults, and stores a safe terminal result before acknowledgement. Identical retries return the stored result. Changed content conflicts. Conflicting lifecycle commands receive `provider.operation_in_progress`. Prepared operations revalidate the same target during restart recovery.

The retained regressions cover initial absence, request invalidation, missing/oversized input, durable retry/conflict, lifecycle races, restart recovery, two-tab convergence, zero provider requests, and synthetic-secret scans across catalog/home data. The operation creates no credential file, connection, generation, identity claim, provider request, or secret-bearing browser value.

### Round-29 verification evidence

| Command | Result |
| --- | --- |
| `pnpm test:unit` | 56 files, 568 tests passed |
| `pnpm test:integration` | 9 files, 298 tests passed |
| `WI_FC_SEED=737373 pnpm test:property` | 16 files, 65 tests passed |
| `pnpm test:process` | 68 files, 108 tests passed in the complete gate |
| `pnpm test:e2e` | 44 tests passed |
| `WI_FC_SEED=737373 pnpm test:fuzz` | Two local rounds passed; 11 files and 43 tests per round, seeds 737373 and 737374 |
| `pnpm check` | 75 files, 938 tests passed |
| Markdown link validation | 82 files, 115 local targets resolved |
| `git diff --check` | Passed |

The tree remains intentionally uncommitted and unpushed. No hosted service or Git transition changed. A fresh independent exact-tree review remains required, and this report does not authorize Milestone 12.

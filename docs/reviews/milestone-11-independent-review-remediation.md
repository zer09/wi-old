# Milestone 11 independent implementation review remediation

Date: 2026-07-30

This ledger records validation of the independent uncommitted-working-tree review. It exists so the same failure modes can be recognized without reconstructing the original review.

## Verdict

The review's overall **FAIL** verdict is valid. The green test suite did not cover several accepted ADR-0013/ADR-0014 safety and recovery requirements. Milestone 11 must not be committed or used as the Milestone 12 entry gate until every open item below has regression coverage and a fresh independent review passes.

Some matrix wording was broader than the demonstrated defect: production OpenAI capability discovery is intentionally unavailable in the fake/no-network milestone, and lack of a live provider transport is not itself an M11 defect. Those qualifications do not change the verdict.

## Finding ledger

| Finding | Validation | Remediation in this working tree | Remaining work |
| --- | --- | --- | --- |
| WI-M11-C1 binding-blind mutation | Confirmed. `put`/`delete` could replace or unlink a valid envelope for another connection. | Added evidence-requiring `replaceBound`/`deleteBound`; replace, logout/delete, and prepared-operation recovery now require connection/provider/auth/generation/envelope evidence. Added mismatch-preservation unit coverage. | Add crash-window coverage and durable `file_observed` transitions. |
| WI-M11-C2 duplicate recovery envelopes | Confirmed. Every readable duplicate received a claimable reference. | Closed scan now groups by original connection+generation and authoritative identity tuple; every ambiguous group is omitted. Added duplicate regression coverage. | Repeat the closed uniqueness proof immediately before durable claim and test first/last-page/root-mutation cases. |
| WI-M11-H1 recovery admission/status | Confirmed and still open. | Recovery commands remain memory-only and internal envelope IDs were removed from browser payloads. | Implement ingress registration, durable reference-free `validating`, epoch close/drain, status reads, restart handling, and the safe browser reconciliation journal. |
| WI-M11-H2 M11 crash matrix | Confirmed and still open. | None. | Add closed test-only failpoints and real child-process restart tests for staging, claim, publish/delete, file observation, terminal commit, acknowledgement, and cleanup. |
| WI-M11-H3 request after lifecycle cutoff | Confirmed. The environment lease only checked its old in-memory snapshot. | Request issuance now reloads current catalog state and rejects deleted, non-ready, owned, generation-changed, or lifecycle-revision-changed connections before invoking the adapter. Added a committed-disable regression assertion. | Replace the read-then-issue check with the ADR-required serialized one-request lease so a lifecycle prepare cannot race between the check and request start; cover file credentials and continuations. |
| WI-M11-H4 cross-ledger command ID reuse | Confirmed. Metadata and lifecycle ledgers checked only themselves. | Lifecycle admission now rejects IDs in the metadata ledger; rename rejects IDs in the lifecycle ledger. Added rename→disable regression coverage. | Extend pairwise coverage across every provider command method and retain one unified namespace invariant. |
| WI-M11-H5 lazy unsafe-root validation | Confirmed. Runtime readiness did not initialize credential roots. | Runtime readiness now initializes roots before operation recovery/listener readiness; shutdown closes recovery and environment lease state. | Add explicit unsafe-root process/startup tests. |
| WI-M11-H6 unbounded enumeration/FD input | Confirmed. `readdir` and `readFile(fd)` retained input before applying limits. | Credential enumeration now uses bounded `opendir` iteration; FD provisioning uses a capped incremental stream. | Add over-cap/endless-input resource tests and similarly bound staged cleanup enumeration. |
| WI-M11-M1 browser `envelopeId` leak | Confirmed. Recovery scan serialized the internal envelope identity. | Removed `envelopeId` from the safe candidate; retained it only in the process-local binding. Added strict protocol response parsing on server and browser and leakage coverage. | Include this field prohibition in browser/network capture tests. |
| WI-M11-M2 expired stage cleanup | Confirmed and still open. `cleanupExpiredUnclaimed` has no caller. | None. | Add bounded startup cleanup backed by a durable claim lookup and claim-vs-cleanup race tests. |
| WI-M11-M3 stale capability cache | Confirmed. Capability publication ignored the updated connection. | Capability publication now refreshes the safe cache with the returned connection and current catalog revision. | Add two-tab/revision convergence coverage. |
| WI-M11-M4 contradictory docs | Confirmed. | This ledger corrects the implementation status and explicitly keeps M11 blocked. | Reconcile `docs/known-limitations.md`, the v0.2 plan status, browser protocol, failure matrix, troubleshooting, and security documentation after behavior is complete. |

## Other validated open review areas

The following review conclusions remain valid and are not silently closed by the localized fixes above:

- no durable `file_observed` cross-store transition;
- no recovery status linearization or safe reload reconciliation;
- no M11 process failpoint suite or independent recovery/environment property model;
- no authoritative identity claim restoration during catalog-loss recovery;
- no startup expired-stage cleanup;
- no atomic one-request lifecycle lease;
- incomplete browser management and multi-tab/race E2E coverage;
- no outbound-network interception proof.

## Regression references

- `packages/credentials/src/file-store.test.ts` — mismatched bound replace/delete preserves the original envelope.
- `packages/credentials/src/recovery.test.ts` — browser-safe scan and duplicate-original ineligibility.
- `tests/integration/provider-connections-storage.test.ts` — metadata/lifecycle command-ID namespace conflict.
- `tests/integration/provider-connection-runtime.test.ts` — committed disable prevents the request callback.

Do not change this ledger from **open** to **resolved** based only on unit/integration success. Resolution requires the missing process/race/reload coverage and a fresh independent exact-tree review.

## Review round 2: post-remediation independent review

A second independent review inspected the corrected uncommitted tree and again returned **FAIL**. Its overall verdict is valid. Finding identifiers below refer to that second review; they intentionally do not replace the first-round identifiers above.

| Round-2 finding | Validation and disposition |
| --- | --- |
| WI-M11-C1 rejected-root mutation | **Confirmed and locally fixed.** Prospective canonical paths, overlap, Windows-drive, and mount-capability checks now run before `mkdir`, `chmod`, or semantic probes. Unit tests prove an overlapping root and a symlink ancestor resolving into `WI_HOME` create neither credential nor staging children. Root-identity races and process startup probes remain required. |
| WI-M11-H1 changed-content file/recovery retries | **Confirmed and locally fixed.** File create, file replace, and recovery now compare the stored operation method and canonical content hash before every terminal duplicate shortcut. Router-level integration tests reuse each command ID with changed content and require `protocol.command_id_conflict`. |
| WI-M11-H2 recovery admission/status | **Confirmed; open.** This is the first-round recovery admission/status blocker. |
| WI-M11-H3 crash matrix/`file_observed` | **Confirmed; open.** Ordinary startup inference is not a substitute for the accepted durable phase and real process-death matrix. |
| WI-M11-H4 file request lease bypass | **Confirmed; open.** The environment preflight added in round 1 is neither atomic nor used for file credentials. A unified serialized one-request lease is required. |
| WI-M11-H5 repeat scan/authoritative recovery claim | **Confirmed; open.** Initial duplicate suppression does not prove uniqueness immediately before durable claim and recovery still does not restore the authoritative claim tuple. |
| WI-M11-H6 stable authoritative winner | **Confirmed and locally fixed for catalog registration.** A losing authoritative registration now durably resolves to the existing winner instead of throwing identity conflict; concurrent worker-RPC integration coverage proves both commands receive one connection and changed-content retry still conflicts. Recovery-side authoritative claims remain open under H5. |
| WI-M11-M1 expired-stage cleanup | **Confirmed; open.** Cleanup still has no startup caller or claim-race proof. |
| WI-M11-M2 exact prior-schema fixtures | **Confirmed; open.** The current fixture is reconstructed by subtracting M11 DDL from current databases and is not an exact retained v5/v4 fixture. |
| WI-M11-M3 test oracles | **Confirmed; partially narrowed.** `provider-lifecycle.test.ts` is now included in the fuzz runner. Independent models, process failpoints, browser inventory, secret scans, and network interception remain absent. |
| WI-M11-M4 contradictory docs | **Confirmed; open.** This ledger states current truth but is not a substitute for reconciling all canonical product documents after implementation completes. |
| WI-M11-M5 stalled credential FD | **Confirmed; open.** Incremental byte bounding does not bound elapsed wait for a descriptor that never produces EOF. |
| WI-M11-M6 leaked environment acceptance lease | **Confirmed; open.** Snapshot creation records the lease before the session acceptance transaction and no rejection hook calls `discard(runId)`. |
| WI-M11-L1 unused `zod` dependency | **Confirmed and fixed.** Removed from `@wi/provider-connections` and regenerated the lockfile. |

### Round-2 regression references

- `packages/credentials/src/roots.test.ts` — zero mutation for direct overlap and symlink-ancestor overlap.
- `tests/integration/provider-connection-runtime.test.ts` — changed-content file create/replace/recovery conflicts.
- `tests/integration/provider-connections-storage.test.ts` — concurrent authoritative commands resolve to one durable winner.
- `scripts/run-fuzz.mjs` — includes the provider lifecycle property suite.

The second review also correctly identifies incomplete file-request leasing, exact recovery, process failpoints, stage cleanup, exact migration fixtures, acceptance rollback, descriptor timeout, browser convergence, secret scans, and no-network interception. These cannot be represented as fixed by adding shallow assertions; they remain explicit release blockers.

## Review round 3: crash retry, capability pin, and runtime defaults

A third independent review again returned **FAIL**. The verdict is valid: recovery admission/status, durable `file_observed`, final recovery rescan/identity claim, unified file/environment request leases, process failpoints, exact migration fixtures, browser reconciliation, and release evidence remain absent.

| Round-3 finding | Validation and disposition |
| --- | --- |
| WI-M11-H1 recovery admission/status/browser reconciliation | **Confirmed; open.** Requires the accepted coordinator, epoch drain, durable `validating`, status contract, restart terminalization, and safe browser journal rather than a localized patch. |
| WI-M11-H2 immediate retry after file effect | **Confirmed; partially remediated.** Bound replacement now treats the operation's unique target binding/envelope as proof that publication already completed; bound deletion treats an already-absent file as deletion-complete while still rejecting a present mismatched envelope. Unit coverage repeats both effects. Durable `file_observed`, closed failpoints, process death, terminal/ack recovery, and stage cleanup remain open. |
| WI-M11-H3 stale recovery scan and authoritative identity | **Confirmed; open.** Initial scan duplicate suppression is insufficient. A final complete scan, normalized tuple claim, source-change tombstone, and conflict tests are still required. |
| WI-M11-H4 file-backed request leases | **Confirmed; open.** Existing request preflight remains environment-only and non-atomic. |
| WI-M11-H5 failed acceptance leaks environment lease | **Confirmed and locally fixed.** `SessionActor` now invokes an explicit provider-snapshot rejection hook only after acceptance fails without successful durable reconciliation; server composition discards both lease indexes. Actor and lease-manager regressions prove rollback. Process/ambiguous-outcome coverage remains desirable. |
| WI-M11-M1 expired stages | **Confirmed; open.** No startup cleanup or claim/cleanup coordination exists. |
| WI-M11-M2 capability version ignored | **Confirmed and fixed.** Default validation and run snapshot resolution now require exact equality with the current connection capability version. A stale-version integration command is rejected with `provider.capabilities_unavailable`. |
| WI-M11-M3 exact migration fixtures | **Confirmed; open.** Subtractive current-schema fixtures remain inadequate. |
| WI-M11-M4 browser inventory/convergence | **Confirmed; open.** |
| WI-M11-M5 canonical documentation contradictions | **Confirmed; open.** This review ledger and operational-limit correction do not replace the final canonical documentation reconciliation. |
| WI-M11-M6 unbounded FD elapsed time | **Confirmed and fixed.** Credential FD reads now have a non-overridable 30-second maximum, destroy the reader on expiry, and have a deterministic fake-timer regression. |
| WI-M11-M7 ignored `XDG_STATE_HOME` | **Confirmed and fixed.** Default root resolution now honors process `XDG_STATE_HOME`, with explicit options retaining precedence and unit coverage of exact paths. |

### Round-3 regression references

- `packages/credentials/src/file-store.test.ts` — replacement-published and deletion-complete identical retries.
- `packages/harness-core/src/session-actor.test.ts` and `packages/credentials/src/environment.test.ts` — failed acceptance discards the run lease/fingerprint.
- `tests/integration/provider-connection-runtime.test.ts` — stale capability version rejection.
- `apps/server/src/credential-cli.test.ts` — silent credential stream deadline.
- `packages/credentials/src/roots.test.ts` — process `XDG_STATE_HOME` defaults.

Milestone 11 remains **blocked**. The localized remediations above do not satisfy the missing recovery coordinator, durable cross-store phase/process matrix, authoritative recovery claim, unified request lease, startup stage cleanup, exact migrations, browser reconciliation, secret scan, no-network interception, or canonical-documentation gates.

## Review round 4: complete blocking-work remediation candidate

The user authorized completing every remaining work package rather than continuing isolated patches. This round implements the previously open blockers as one dependency-ordered remediation:

| Blocking area | Round-4 disposition |
| --- | --- |
| Durable cross-store file lifecycle | **Implemented.** File create, replace, logout/delete, and credential recovery now durably transition through `prepared` → `file_observed` → terminal. Exact old binding, target binding, and deletion-complete evidence make identical retries safe; terminal logout/delete clears obsolete credential references. |
| Lifecycle crash matrix | **Implemented.** Closed test-only failpoints cover prepare, file effect, durable observation, terminal-before-ack, stage cleanup, recovery admission/prepare, and environment acceptance-before-request. Real child-process tests cover create, replace, delete, recovery, and environment restart windows. |
| Recovery admission and status | **Implemented.** Recovery persists a reference-free `validating` admission before consuming the memory-only reference. Status reads expose bounded `admitting`, `unobserved`, `validating`, `prepared`, `file_observed`, terminal, and `not_accepted` states. Ingress registration prevents final non-acceptance while the recovery command is being routed; restart terminalizes stranded validation as `credential.recovery_ref_expired`. |
| Browser recovery reconciliation | **Implemented.** A separate bounded session journal stores only command ID, operation kind, nonclaiming epoch/expiry, and display metadata. The full command and `recoveryRef` remain memory-only. Reload polling removes entries only after a terminal or proven `not_accepted` status. |
| Final recovery claim | **Implemented.** Claim performs another complete bounded root scan, verifies the exact envelope remains unique, and rejects stale or newly duplicated evidence. Authoritative identity tuples are restored transactionally before the connection can become ready. |
| File/environment request leases | **Implemented for the M11 no-network boundary.** Every fixture request acquires a connection/generation/revision-bound request lease under the same per-connection cutoff lock as lifecycle preparation. File requests verify the exact current envelope; environment requests rematch the process fingerprint. Pre-cutoff requests may settle, while later requests fail after cutoff. |
| Environment acceptance/restart | **Implemented.** Failed durable acceptance discards the provisional fingerprint. A real process failpoint proves a durably accepted environment-backed run is interrupted after backend restart without issuing a provider request. |
| Stage cleanup | **Implemented.** Startup recovers nonterminal owners, removes terminally consumed stages, then removes expired unclaimed stages while preserving active claims. |
| Prior-version migrations | **Implemented.** Process fixtures now construct catalog v5 and session v4 by applying only the exact retained migration chain; they no longer create current schemas and subtract M11 objects. |
| Browser operation inventory/convergence | **Implemented.** The panel exposes create, replace, rename, disable, logout, delete, recovery, and session-default selection. E2E proves safe cross-tab connection/rename convergence. |
| Property/fuzz, secret, and no-network evidence | **Implemented.** A new credential-evidence property is in the local fuzz inventory; runtime tests scan `WI_HOME` SQLite/sidecars for known staged/replacement secrets and intercept global fetch during a selected-provider run. |
| Canonical documentation | **Reconciled.** Known limitations, browser protocol, storage/failure boundaries, migrations, security, and operational limits now distinguish released v0.1 from implemented fake/no-network M11 behavior. |

### Round-4 verification

- focused unit/integration/property/process remediation gate: 11 files, 114 tests passed;
- `pnpm check`: 93 files, 1,022 tests passed; 10 package entry points verified;
- `pnpm test:e2e`: 35 tests passed;
- `pnpm test:fuzz`: local seed 737373, 10 files and 39 tests passed;
- `git diff --check`: passed;
- default credential root: zero files.

The implementation blockers recorded by the three supplied reviews are now represented by code and executable evidence. **Release progression is still blocked on a fresh independent review of this corrected tree and the repository's exact-head commit/CI/remote approval/merge attestation sequence.** This ledger is implementation evidence, not self-approval.

## Independent local review round 1

A fresh read-only `openai-codex/gpt-5.6-sol` high-reasoning Pi subprocess reviewed the complete uncommitted tree using `prompts/v0.2-milestone-11/02-independent-implementation-review.md`. Its verdict was **FAIL**. The following findings were independently validated and remediated:

| Finding | Disposition |
| --- | --- |
| `WI-M11-C1` final recovery scan could miss a duplicate inserted after its enumeration snapshot | **Fixed.** Claim now compares a second sorted root-membership snapshot and re-reads the exact selected envelope before claiming. A deterministic store mutation test inserts a duplicate during the claim read and receives `credential.scan_incomplete`. |
| `WI-M11-H1` ordinary missing/invalid stage or file errors could retain a `prepared` owner until restart | **Fixed.** Pre-effect failures durably terminalize as `failed`; uncertain file-effect failures terminalize as `failed_after_effect` and unavailable. Terminal stage-cleanup failure cannot change an already-durable acknowledgement. A missing-stage-after-prepare integration test proves owner release and stable retry. |
| `WI-M11-H2` recovery status could report `not_accepted` while a WebSocket frame remained queued before service registration | **Fixed.** Bounded frame admission now synchronously registers recovery ingress before the serialized inbound queue. Exact command/epoch reference counts drain only after that frame settles. An integration test blocks an earlier command, queues recovery, and observes `admitting` before routing starts. Status remains method/operation/epoch checked against durable recovery rows. |
| `WI-M11-H3` browser-authored prompt/tool hashes entered durable defaults and run snapshots | **Fixed.** Browser default commands no longer contain prompt/tool identity. The backend derives prompt version and a canonical hash of the configured tool definitions, validates restored defaults against that authority, and persists only the resolved server-owned values. |
| `WI-M11-H4` recurrence evidence did not cover the newly demonstrated defects | **Improved with direct oracles.** Added root-membership mutation, ordinary prepared failure, queued-ingress, restart-cache, healthy-catalog scan, server-derived snapshot, UTF-8 boundary, and target-collision tests in addition to the existing lifecycle process matrix. |
| `WI-M11-M1` mutation-before-first-list after restart marked a partial safe-view cache complete | **Fixed.** Mutation-only cache entries remain incomplete; the first list reloads the complete durable catalog. Restart/mutation coverage proves both connections remain visible. |
| `WI-M11-M2` recovery scan was callable while a healthy provider catalog was authoritative | **Fixed.** Startup enables the process-local recovery mode only when the catalog has no provider rows and the credential root contains retained envelopes. Healthy file-backed catalogs reject scan initiation. |
| `WI-M11-M3` command display-name limits counted UTF-16 units instead of UTF-8 bytes | **Fixed.** All provider display-name commands reuse the safe-view UTF-8-bounded schema; 256-byte and one-code-point-over emoji cases are tested. |
| `WI-M11-M4` security documentation said there was no API-key handling | **Fixed.** The text now distinguishes local M11 OpenAI Platform API-key storage from the intentionally absent live OpenAI request/adapter. |
| Additional review matrix note: file create could replace an unexpected existing random target | **Fixed defensively.** `put` is now idempotent only for the exact same target credential and rejects any conflicting complete target without mutation; bound replacement retains its evidence-authorized write path. |

Post-remediation evidence:

- focused protocol/credential/runtime suites: 3 files, 22 tests passed;
- queued-ingress integration test passed;
- provider lifecycle process suite: 17 tests passed;
- M11 Playwright suite: 1 test passed;
- `pnpm check`: 93 files, 1,027 tests passed; 10 package entry points verified.

The round-1 FAIL report is preserved as review history. A second fresh independent local review is required; these dispositions are not self-approval.

## Independent local review round 2

The second fresh read-only Pi review returned **PASS WITH REQUIRED FIXES** and identified two high-severity lifecycle defects plus one missing required process boundary:

| Finding | Disposition |
| --- | --- |
| `WI-M11-H1` the service-wide connection lock queued conflicting lifecycle commands until the owner completed | **Fixed.** The lock now covers only lifecycle prepare/cutoff or request admission. Different commands reach transactional owner admission immediately and persist `provider.operation_in_progress`; active identical commands share one task only when their canonical content matches. A controlled `replaceBound` gate proves disable receives a durable conflict before replacement settles and returns the same conflict after owner terminalization. |
| `WI-M11-H2` a safe pre-effect replacement failure left catalog generation 2 while the retained file remained generation 1 | **Fixed.** Replace prepare records the previous envelope as safe evidence. A pre-effect failure proves that exact old envelope/generation, terminalizes failed, restores only the prior credential generation and ready status, preserves the incremented lifecycle cutoff, and permits a newly staged replacement to complete. Unprovable or post-effect failures remain unavailable/`failed_after_effect`. |
| `WI-M11-M1` no real process failpoint existed after durable stage publication and before returning `provisioningRef` | **Fixed.** `CredentialProvisioner` has closed injected hooks at both boundaries; corresponding provider-command failpoints and real child-process tests prove abnormal exit leaves one unreturned stage, no connection/ref/secret output, and bounded startup expiry cleanup. |

Post-remediation evidence:

- lifecycle conflict/restaging/runtime tests: 6 passed;
- provider lifecycle process suite: 19 passed, including both new stage-publication boundaries;
- `pnpm check`: 93 files, 1,029 tests passed; 10 package entry points verified.

Round 2 remains part of the audit trail. A third fresh independent local review is required before any release progression.

## Independent local review round 3

The third fresh review returned **PASS WITH REQUIRED FIXES**. Its confirmed findings and dispositions are:

| Finding | Disposition |
| --- | --- |
| `WI-M11-H1` restart recovery accepted a target `envelopeId` without checking the remaining envelope binding | **Fixed.** A target-complete restart now verifies connection, provider, auth mode, reserved generation, and identity before observation. A real crash test mutates connection binding while preserving the target envelope ID and proves `failed_after_effect`/unavailable with evidence retained. |
| `WI-M11-H2` scan uniqueness keyed original identity by connection+generation and raw authoritative JSON | **Fixed.** Original ambiguity is keyed by connection ID across all generations. Authoritative ambiguity uses the same canonical stable-identity precedence/workspace key as transactional catalog claims during both scan and final claim. Different-generation and equivalent-subject tests yield no candidates. |
| `WI-M11-H3` startup stage enumeration used materializing `readdir` and scans lacked elapsed bounds | **Fixed.** Stage cleanup streams `opendir`, caps 1,000 stages/4,000 total entries, and enforces a 10-second completed-work deadline. Credential/recovery scans use matching streaming/count/deadline bounds. A 1,001-stage test fails closed without full-list retention. |
| `WI-M11-M1` safe-view cache hid lifecycle prepare/failure revisions | **Fixed.** The server no longer caches provider safe views; each bounded poll reads the canonical catalog projection and preserves truncation/revision. |
| `WI-M11-M2` documented pnpm FD forwarding was not operational | **Fixed.** README now documents masked TTY through pnpm and the verified direct built-Node entrypoint for inherited descriptors, avoiding package-manager FD reuse. |
| `WI-M11-M3` recovery status could not correlate expected safe metadata | **Fixed.** Durable status returns the strict expected-safe-metadata projection. The bounded browser journal stores that already-safe scan metadata and rejects a non-null durable mismatch before terminal reconciliation. |
| `WI-M11-M4` changed/missing environment credentials left catalog status ready | **Fixed.** Request-time fingerprint failure atomically marks the matching ready environment connection unavailable and increments lifecycle revision; concurrent changed ownership is not overwritten. Runtime coverage asserts safe unavailability. |
| `WI-M11-M5` no-network proof intercepted only `fetch` | **Fixed.** A real selected-provider child process denies fetch, WebSocket, HTTP/HTTPS, DNS, TCP, TLS, and child-process primitives before dynamically loading Wi, then completes with zero attempts. |

Post-remediation evidence:

- focused unit/integration/process gate: 5 files, 37 tests passed;
- provider process suite: 21 tests, including binding-mismatch and transport-denial proofs;
- `pnpm check`: 93 files, 1,034 tests passed; 10 package entry points verified.

A fourth fresh independent local review is required. No round is self-approval.

## Independent local review round 4

The fourth fresh review returned **PASS WITH REQUIRED FIXES**. Its confirmed findings and dispositions are:

| Finding | Disposition |
| --- | --- |
| `WI-M11-H1` secret-bearing pre-rename temporary files were outside startup cleanup | **Fixed.** Credential and staging roots now remove only strict generated `.tmp-<32 hex>` and `.tmp-stage-<32 hex>` files after no-follow regular-file, current-owner, single-link, and `0600` validation. Cleanup runs before bounded root inventory. Closed pre-rename failpoints and real child-process tests prove both orphan classes are removed before recovery proceeds; unrelated lookalike names remain untouched. |
| `WI-M11-M1` provider-list HTTP passed internal credential fields into the strict safe schema | **Fixed.** The service explicitly projects each durable record through `ProviderConnectionSafeViewSchema`, omitting `credentialInternalRef` and `envelopeId`. The expanded two-connection multi-tab Playwright scenario now lists, renames, disables, and observes convergence successfully. |
| `WI-M11-M2` recovery status did not bind the request's operation kind and expected safe metadata | **Fixed.** Authenticated status reads require unique bounded headers carrying the fixed operation kind and base64-encoded strict expected metadata. The service compares that tuple against queued ingress and durable recovery rows, reports typed `conflict` on mismatch or lifecycle/metadata-ledger command-ID reuse, and returns `not_accepted` only after no matching ingress or durable command exists. |
| `WI-M11-M3` independent property and browser recurrence coverage remained narrow | **Improved with independent models and broader browser inventory.** New fast-check reference models cover recovery-journal add/remove/reload sequences and environment request-lease fingerprint/binding/discard sequences; the timed fuzz file list includes them. The M11 E2E now creates two same-provider connections and proves cross-tab list, rename, disable, and session-selector convergence. |
| `WI-M11-M4` `/proc/self/mountinfo` parsing had no byte, line, or field bounds | **Fixed.** Mount inspection now streams at 64 KiB chunks and fails closed above 1 MiB, 16,384 lines, 16 KiB per line, or 256 fields before parsing path data. |

Post-remediation evidence:

- lint and typecheck passed;
- focused unit/integration/property/process gate: 8 files, 154 tests passed;
- `pnpm check`: 94 files, 1,041 tests passed; 10 package entry points verified;
- `pnpm test:e2e`: 35 tests passed, including the expanded multi-tab M11 inventory;
- two local fuzz invocations from seeds `737373` and `737374`: each round passed 11 files and 41 tests, including the new control-plane reference models;
- `git diff --check`: passed;
- default credential root: zero files.

A fifth fresh independent review remains required. This disposition is implementation evidence, not self-approval.

## Independent local review round 5

The fifth fresh review returned **PASS WITH REQUIRED FIXES**. Its confirmed findings and dispositions are:

| Finding | Disposition |
| --- | --- |
| `WI-M11-H1` claimed recovery source changes lacked the required tombstone | **Fixed.** Claimed source disappearance/binding failure now terminalizes as `failed_after_effect` with `credential.recovery_source_changed`, consumes the claim, and atomically sets an unavailable recovery tombstone. A real crash/restart test deletes the source after prepare, proves the exact durable outcome, then completes explicit staged replacement at generation 4 and clears the tombstone. |
| `WI-M11-H2` request leases validated credentials but discarded them before adapter invocation | **Fixed.** The request lease now retains the exact captured key only until release and exposes it solely through a request-scoped backend callback into `ProviderContext.credential`; it never enters `ProviderRequest`. The selected fake fixture records only canary equality. File and environment issuance are asserted, and an environment mutation after first-step issuance causes the post-tool continuation lease to reject before a second adapter call and durably marks the connection unavailable. |
| `WI-M11-H3` provider-service shutdown cleared process state without draining | **Fixed.** Provider connection admission now closes first; asynchronous close drains lifecycle tasks, connection locks, recovery ingress, and active request leases under the shared absolute deadline before clearing scanner/lease state. Runtime shutdown closes storage only after that drain succeeds. A controlled held request lease proves provider close remains pending until release. |
| `WI-M11-M1` initial recovery discovery did not re-close membership before publishing references | **Fixed.** Discovery now compares a second sorted root-membership snapshot before generating any `recoveryRef`. A deterministic store inserts a duplicate during candidate reads and receives `credential.scan_incomplete` with no scan result. |
| `WI-M11-M2` service/browser recurrence coverage was incomplete | **Expanded.** The controlled service race now checks replace against disable, logout, delete, and a second replacement while rename succeeds on the disjoint metadata revision. Browser E2E now covers file create/replace/logout/delete across tabs and a separate memory-only recovery command blocked before route, page reload, status reconciliation, journal removal, and restored connection. OAuth refresh/reauthenticate remain outside M11 implementation scope. |
| `WI-M11-M3` canonical implementation-status/event/failure/troubleshooting docs were stale | **Fixed.** The v0.2 plan, provider architecture, ADR index, event catalog, failure matrix, troubleshooting, and operational limits now distinguish the released v0.1 baseline, implemented fake/no-network M11 candidate, and unimplemented M12+ work. An architecture test pins schema versions, M11 event names, implementation claims/exclusions, and every M11 failpoint. |
| `WI-M11-L1` distinct-worker integration coverage used probabilistic random IDs | **Fixed.** The test deterministically selects one valid session ID for each worker index and injects those IDs into storage, eliminating the eight-random-attempt flake. |

Post-remediation evidence:

- lint and typecheck passed;
- focused architecture/unit/integration/process gate: 7 files, 136 tests passed;
- provider lifecycle process suite: 25 tests, including source-change tombstone and replacement;
- `pnpm check`: 95 files, 1,045 tests passed; 10 package entry points verified;
- `pnpm test:e2e`: 36 tests passed, including file lifecycle and recovery reload scenarios;
- two local fuzz invocations from seeds `737373` and `737374`: each round passed 11 files and 41 tests.

A sixth fresh independent review remains required. This disposition is implementation evidence, not self-approval.

## Independent local review round 6

The sixth fresh review returned **FAIL**. Its confirmed findings and dispositions are:

| Finding | Disposition |
| --- | --- |
| `WI-M11-H1` recovering one retained envelope closed recovery after restart and stranded additional envelopes | **Fixed.** Catalog v6 now persists `recovery_active`. Starting catalog-loss recovery sets it before issuing references; each successful claim re-scans bounded credential membership against durable connections and clears it only when every retained envelope is represented. A real child-process test recovers two envelopes in separate process lifetimes. |
| `WI-M11-H2` claim closure checked ref membership but not same-ref content replacement | **Fixed.** Claim now performs a second full bounded envelope-content load and recomputes connection and authoritative-identity uniqueness before acceptance. Deterministic same-reference substitution coverage proves a newly duplicated binding is rejected. |
| `WI-M11-H3` deferred refresh and reauthentication publication lacked required recurrence/crash fixtures | **Fixed within M11's no-network boundary.** The file-effect recovery path now recognizes test-only same-generation refresh publication alongside reauthentication. Closed child-process fixtures cover prepare, file effect, `file_observed`, terminal-before-ack, and cleanup for both operations. Storage coverage proves refresh-plus-logout and delete-plus-reauthenticate ownership conflicts; existing service coverage retains replace-plus-disable/logout and dual-replace races. No OAuth or network behavior was added. |
| `WI-M11-H4` recovery scans and status reads lacked aggregate admission bounds | **Fixed.** Recovery scanning is one process-wide single flight: concurrent callers join the same promise and an open completed epoch returns the same result. Status reads enforce a 32-in-flight cap and a 128-read one-second process-wide window, returning typed `rate_limited`; a 40-way concurrent regression proves eight are rejected. |
| `WI-M11-M1` relative `XDG_STATE_HOME` was accepted | **Fixed.** Root option parsing rejects non-absolute configured XDG, credential, staging, and `WI_HOME` paths before canonicalization, directory creation, chmod, mount inspection, or probes. Tests assert zero filesystem mutation. |
| `WI-M11-M2` M11 property suites ignored fuzz seed changes | **Fixed.** Provider lifecycle and control-plane model properties derive their seed from `WI_FC_SEED` with a random local fallback; explicit `737373` and `737374` fuzz invocations now vary those suites and remain reproducible. |

Post-remediation evidence:

- lint and typecheck passed;
- focused unit/integration/property gate: 6 files, 35 tests passed;
- provider lifecycle process suite: 36 tests passed, including ten refresh/reauthentication publication crash windows and multi-envelope cross-process recovery;
- `pnpm check`: 95 files, 1,062 tests passed; 10 package entry points verified;
- `pnpm test:e2e`: 36 tests passed;
- local fuzz invocations beginning at seeds `737373` and `737374`: every round passed 11 files and 41 tests;
- `git diff --check`: passed.

A seventh fresh independent review remains required. This disposition is implementation evidence, not self-approval.

## Independent local review round 7

The seventh fresh review returned **PASS WITH REQUIRED FIXES**. Its confirmed browser findings and dispositions are:

| Finding | Disposition |
| --- | --- |
| `WI-M11-H1` equal aliases made explicit selection and destructive lifecycle actions visually ambiguous | **Fixed.** Connection rows, management options, and session-default options now render provider, auth mode, backend, and authoritative subject/account/project/workspace/plan context. Unverified identities render the full stable safe `connectionId` discriminator. Recovery candidates likewise show auth mode and original connection ID. Playwright creates two equal-alias unverified connections, proves both option labels remain distinct, disables the intended ID only, and verifies both IDs remain distinguishable in session selection. |
| `WI-M11-M1` used or expired recovery references remained in component memory | **Fixed.** The submitted candidate is removed immediately after the complete command is handed to the socket, with the safe reconciliation entry removed on synchronous rejection. Scan state is also cleared at its exact expiry and on every terminal reconciliation outcome. Playwright injects a short browser-visible expiry and proves candidate removal, then rescans and proves the submitted candidate disappears before the blocked command routes and remains absent through reload/terminal settlement. |

Post-remediation evidence:

- lint and typecheck passed;
- focused Milestone 11 Playwright suite: 2 tests passed;
- `pnpm check`: 95 files, 1,062 tests passed; 10 package entry points verified;
- `pnpm test:e2e`: 36 tests passed;
- local fuzz invocations beginning at seeds `737373` and `737374`: every round passed 11 files and 41 tests.

An eighth fresh independent review remains required. This disposition is implementation evidence, not self-approval.

## Independent local review round 8

The eighth fresh review returned **PASS WITH REQUIRED FIXES**. Its confirmed findings and dispositions are:

| Finding | Disposition |
| --- | --- |
| `WI-M11-M1` shutdown omitted active recovery scans and status reads | **Fixed.** Provider close now admits neither new scan nor status work, includes the active scan promise and status-read count in the deadline-bounded drain condition, and closes process-only scanner state only after both settle. Scan completion checks the shutdown cutoff before publishing an epoch/result. Controlled fixture gates hold both operations concurrently, prove close remains pending, release them, prove the scan returns `server.shutting_down`, and verify repeated close/new admission behavior. |
| `WI-M11-M2` provider-default UI retained the prior session/connection/model | **Fixed.** Local selection now synchronizes from `selectedSessionId` and the durable default's connection/model fields. Capability changes clear stale snapshots and preserve a model only if the new connection still advertises it; otherwise they select the new first model or clear. Playwright uses two sessions, two file connections, and disjoint fixture model inventories to prove durable A/B default restoration and manual connection/model switching. |
| `WI-M11-M3` prior-version migration fixtures reused current production history and lacked v6/v5 rollback | **Fixed.** Frozen independent catalog-v5 and session-v4 SQL fixtures now live under `tests/process/fixtures/` and contain representative retained catalog metadata, manifest, run, and immutable event rows. The fixture no longer imports current migration arrays to construct prior state. Injected failures after current v6/v5 DDL prove transaction rollback leaves old `user_version`, prior data, and absent new schema, followed by successful production retry and retained-row decoding. |

Post-remediation evidence:

- lint and typecheck passed;
- focused integration/process gate: 2 files, 12 tests passed;
- focused Milestone 11 Playwright suite: 3 tests passed;
- `pnpm check`: 95 files, 1,065 tests passed; 10 package entry points verified;
- `pnpm test:e2e`: 37 tests passed;
- local fuzz invocations beginning at seeds `737373` and `737374`: every round passed 11 files and 41 tests.

A ninth fresh independent review remains required. This disposition is implementation evidence, not self-approval.

## Independent local review round 9

The ninth fresh review returned **FAIL**. Its confirmed findings and dispositions are:

| Finding | Disposition |
| --- | --- |
| `WI-M11-H1` a recovery tombstone with retained changed evidence could not be explicitly replaced | **Fixed.** Explicit replacement of any recovery tombstone allocates a new internal credential reference instead of authorizing mutation through stale evidence. The changed original file remains untouched for operator disposition, while the catalog binds only the newly staged generation. The same command, provisioning reference, target envelope, and fresh internal reference are durable across prepare, temporary-file flush, file effect, `file_observed`, terminal-before-ack, and stage-cleanup crashes. Real child-process tests retain deliberately mismatched old evidence and prove identical retry reaches ready generation 4 with exactly the old and new files. |
| `WI-M11-H2` the credential CLI lacked the required Linux process-list and shell-history secrecy proof | **Fixed.** A real child-process test starts the built CLI with an inherited descriptor held open, reads `/proc/<pid>/cmdline` before writing the synthetic API key, and uses a controlled shell-history file containing only the descriptor invocation. It then proves the key is absent from arguments, history, stdout, stderr/diagnostics, and every file under `WI_HOME`; the only containing file is the expected private staging envelope outside `WI_HOME`. |
| `WI-M11-M1` selected-provider failures were attributed to the composed base adapter | **Fixed.** `AgentRunLoop` now reports diagnostics with the run-selected adapter's `id`. An integration regression persists an `openai_platform` run selection, forces that selected adapter to fail, and proves the diagnostic names `openai_platform` rather than the base `fake` provider. |

Post-remediation evidence:

- lint and typecheck passed;
- focused integration/process gate: 4 files, 74 tests passed;
- retained-evidence tombstone replacement passed all six lifecycle crash windows;
- credential CLI Linux process-list/history boundary test passed;
- `pnpm check`: 96 files, 1,073 tests passed; 10 package entry points verified;
- `pnpm test:e2e`: 37 tests passed;
- local fuzz invocations beginning at seeds `737373` and `737374`: every round passed 11 files and 41 tests;
- `git diff --check`: passed;
- default credential-root inspection: zero files.

A tenth fresh independent review remains required. This disposition is implementation evidence, not self-approval.

## Independent local review round 10

The tenth fresh review returned **PASS WITH REQUIRED FIXES**. Its confirmed findings and dispositions are:

| Finding | Disposition |
| --- | --- |
| `WI-M11-H1` generated credential/stage FIFOs blocked before regular-file validation | **Fixed.** Every generated credential and stage read now uses `O_NOFOLLOW | O_NONBLOCK` before descriptor validation, so FIFOs cannot wait for a writer. Unit tests cover both stores; a real child-process test creates both FIFO forms and proves bounded `credential.unsafe_file` rejection under a two-second deadline. |
| `WI-M11-H2` prepared operations with missing target connections were skipped forever | **Fixed.** A dedicated catalog transaction terminalizes only a nonterminal operation whose target is absent, records `provider.connection_not_found`, removes its owner, consumes its credential claim, advances catalog revision, and makes its stage eligible for normal terminal cleanup. A crash/restart process test removes the target after prepare and proves terminal failure, stable retry, zero owners, consumed claim, removed private stage, and secret-free output. |
| `WI-M11-H3` post-commit maintenance exceptions could reject durable command success | **Fixed.** Environment/file capability publication and post-recovery availability refresh are isolated after durable commit. Failures create redacted `provider_connection_maintenance_failed` diagnostics, enter bounded process-local repair state, and never alter the committed acknowledgment. Browser connection listing retries pending work; startup republishes fixture capabilities. Injected environment, file, and recovery failures prove accepted durable results and subsequent repair. |
| `WI-M11-H4` matching target metadata could hide the wrong credential material | **Fixed.** File idempotency now compares the intended binding, canonical identity, and bounded API-key bytes with `timingSafeEqual`; matching metadata with a different secret fails closed without mutation. Restart recovery always re-derives staged create/replace/refresh/reauthenticate targets and invokes that complete comparison before success. A file-effect crash followed by exact-metadata secret substitution terminalizes unavailable and preserves the conflicting evidence. |
| `WI-M11-M1` represented refs were excluded before whole-root recovery uniqueness | **Fixed.** Recovery scans and claims load and count the complete bounded managed root first; the represented-ref predicate is applied only when emitting unique candidates. Coverage proves represented A plus duplicate A′ emits neither while independent B remains recoverable. |
| `WI-M11-M2` status/pending equality used order-sensitive `JSON.stringify` | **Fixed.** Recovery expected-metadata, in-memory pending commands/drafts, journal draft references, and provider-chain comparison now use canonical JSON semantics. Recursively reordered nested command content is accepted as identical while scalar changes still conflict. |
| `WI-M11-M3` provider-chain compatibility lacked a complete independent mutation oracle | **Fixed.** A seed-sensitive fast-check property permutes and independently mutates routing policy/decision, connection, generation, lifecycle revision, backend/process epoch, provider/auth, subject/workspace, model, capability/accepted-capability fields, prompt/tool schema, reasoning, and transport, requiring a new chain for every mutation. Recursive key-order permutation proves semantic equality still reuses the chain. |

Post-remediation evidence:

- lint and typecheck passed;
- consolidated affected gate: 10 files, 125 tests passed;
- full provider lifecycle process suite: 45 tests passed;
- `pnpm check`: 96 files, 1,082 tests passed; 10 package entry points verified;
- `pnpm test:e2e`: 37 tests passed;
- local fuzz invocations beginning at seeds `737373` and `737374`: each passed 11 files and 43 tests;
- `git diff --check`: passed;
- default credential-root inspection: zero files.

An eleventh fresh independent review remains required. This disposition is implementation evidence, not self-approval.

## Independent local review round 11

The eleventh fresh review returned **PASS WITH REQUIRED FIXES**. Its confirmed findings and dispositions are:

| Finding | Disposition |
| --- | --- |
| `WI-M11-R11-C1` a valid stage could replace the durably claimed source after prepare | **Fixed.** Every post-prepare stage read now compares the envelope's `provisioningId`, provider, and auth mode with the lifecycle operation and target connection before exposing key bytes to a file effect. The shared check covers create, replace, restart recovery, and test-only refresh/reauthentication publication. Real child-process tests crash after replacement prepare, substitute provisioning ID, provider, or auth evidence independently, and prove terminal pre-effect failure, retained old generation/readiness, no published target, removed stage, and one old credential file. |
| `WI-M11-R11-H1` restart treated a provably pre-effect missing replacement stage as `failed_after_effect` | **Fixed.** Restart now classifies evidence before terminalization. A prepared fresh target is pre-effect only when absent; an in-place replacement/refresh/reauthentication is pre-effect only when the exact old generation/envelope remains. Those proven cases use the existing safe `failed` path that restores generation/readiness; all unprovable or observed cases remain `failed_after_effect`. A process test deletes the claimed stage after prepare, proves ready generation 1 and stable failure after restart, then completes a new staged replacement at generation 2. |

Post-remediation evidence:

- lint and typecheck passed;
- real-process substituted/missing claimed-stage regressions: 2 tests passed;
- same-process missing-stage regression remained green;
- `pnpm check`: 96 files, 1,084 tests passed; 10 package entry points verified;
- provider lifecycle process suite: 47 tests passed;
- `pnpm test:e2e`: 37 tests passed;
- local fuzz invocations beginning at seeds `737373` and `737374`: each passed 11 files and 43 tests;
- `git diff --check`: passed;
- default credential-root inspection: zero files.

A twelfth fresh independent review remains required. This disposition is implementation evidence, not self-approval.

## Independent local review round 12

The twelfth fresh review returned **PASS WITH REQUIRED FIXES**. Its confirmed findings and dispositions are:

| Finding | Disposition |
| --- | --- |
| `WI-M11-H1` normal terminal runs retained environment acceptance leases | **Fixed.** Runtime composition now discards the run-scoped provider lease in the run-task terminal `finally` path, covering completed, failed, cancelled, and interrupted execution without weakening per-request lease release. The selected environment-run integration proves a completed run has no retained lease. |
| `WI-M11-H2` provider-default exact retries validated current live connection state before durable command identity | **Fixed.** `SessionActor` serializes the raw browser command, hashes and checks the durable accepted-command row first, and resolves/validates the authoritative default only for a new command. An exact retry after the selected connection is disabled returns its original duplicate acceptance; changed content still conflicts. |
| `WI-M11-M1` a closed recovery epoch could return `not_accepted` before a late command created a durable failed admission | **Fixed.** New ingress registration requires the exact epoch to remain open. Recovery routing admits only a registered ingress or a synchronously open epoch, installing an internal marker before its first admission await; existing durable retries remain available after closure. Coverage proves `not_accepted` remains final with no lifecycle row, while a real open-epoch frame queued behind another command is still visible as `admitting` and completes normally. |
| `WI-M11-M2` the review's complete integration/process/check gates timed out | **Superseded by corrected-tree complete gates.** `pnpm test:integration` passed 9 files/282 tests, `pnpm test:process` passed 12 files/160 tests, and `pnpm check` passed without timeout. The one affected queued-ingress test was also changed from a fabricated epoch to a real bounded recovery scan and passes in 428 ms. |

Post-remediation evidence:

- lint and typecheck passed;
- SessionActor unit suite: 48 tests passed; corrected real-epoch queued-ingress regression: 1 test passed;
- `pnpm test:integration`: 9 files, 282 tests passed, including the runtime and gateway regressions;
- `pnpm test:process`: 12 files, 160 tests passed;
- `pnpm check`: 96 files, 1,085 tests passed; 10 package entry points verified;
- `pnpm test:e2e`: 37 tests passed;
- local fuzz invocations beginning at seeds `737373` and `737374`: two rounds each passed 11 files and 43 tests;
- `git diff --check`: passed;
- default credential-root inspection: zero files.

A thirteenth fresh independent review remains required. This disposition is implementation evidence, not self-approval.

## Independent local review round 13

The thirteenth fresh review returned **PASS WITH REQUIRED FIXES**. Its confirmed findings and dispositions are:

| Finding | Disposition |
| --- | --- |
| `WI-M11-M1` initial recovery discovery closed filename membership but not same-filename envelope metadata | **Fixed.** The bounded discovery scan now retains a canonical metadata snapshot for every loaded managed ref, re-reads every unchanged final ref after the membership closure, and rejects `credential.scan_incomplete` before creating an epoch or recovery reference when any metadata/envelope identity changed. A deterministic fake store returns the same ref list while atomically replacing the selected envelope with another connection and proves no scan result is published. |
| `WI-M11-L1` security documentation called implemented recovery “Planned” | **Fixed.** `docs/security.md` now describes Milestone 11 recovery as implemented. The architecture truth suite rejects the stale phrase and requires the corrected statement. |

Post-remediation evidence:

- lint and typecheck passed;
- focused recovery/docs/runtime gate: 3 files, 22 tests passed;
- `pnpm test:process`: 12 files, 160 tests passed;
- `pnpm check`: 96 files, 1,086 tests passed; 10 package entry points verified;
- `pnpm test:e2e`: 37 tests passed;
- 60-second local fuzz invocation beginning at seed `737373`: two rounds at seeds `737373` and `737374`, each passing 11 files and 43 tests;
- `git diff --check`: passed;
- default credential-root inspection: zero files.

A fourteenth fresh independent review remains required. This disposition is implementation evidence, not self-approval.

## Independent local review round 14

The fourteenth fresh review returned **PASS WITH REQUIRED FIXES**. Its confirmed findings and dispositions are:

| Finding | Disposition |
| --- | --- |
| `WI-M11-R14-C1` recovery discovery and claim closure omitted secret bytes | **Fixed.** Every closed-root recovery snapshot now includes a keyed, process-local API-key fingerprint in addition to canonical metadata. Discovery re-read, claim re-read, and the post-claim service verification all require complete secret-bearing evidence without exposing the key or fingerprint in the candidate/status result. Deterministic tests independently substitute only key bytes during discovery, claim, and post-claim verification and reject each substitution. |
| `WI-M11-R14-H1` unknown-workspace authoritative identities were treated as globally unique | **Fixed.** Recovery uniqueness no longer creates an authoritative identity key when workspace presence is `unknown`, and catalog environment registration/recovery deliberately suppresses identity-claim insertion for unknown workspace. Explicit `none` and concrete workspace values retain serialized winner semantics. Unit and storage integration tests prove two same-subject unknown-workspace records remain independently claimable/registrable. |
| `WI-M11-R14-H2` the credential CLI failed when `WI_HOME` did not exist | **Fixed.** Credential-root initialization now prospectively canonicalizes `WI_HOME` instead of requiring `realpath` success. It still performs overlap and mount preflight before creating only credential/staging directories; it does not create catalog/session state. Root and real CLI process tests now begin with absent `WI_HOME` and succeed while keeping that home empty. |
| `WI-M11-R14-H3` terminal pre-effect failures retained claimed stages in-process and cleanup read unsafe modes | **Fixed.** Every ordinary pre-effect terminal failure immediately attempts bounded claimed-stage deletion and clears the durable cleanup cursor; terminal state remains authoritative if cleanup itself fails and startup retries. Expired-stage cleanup now requires exact `0600` before read. A new stable failpoint at stage unlink-before-directory-flush (exit 113) proves restart cleanup for create, replace, and retained-evidence replacement, while a same-process malformed-stage regression proves immediate removal. |
| `WI-M11-R14-H4` catalog-only disable used separate prepare and terminal transactions | **Fixed.** Storage now exposes one `disableProviderConnection` catalog RPC whose outer SQLite transaction performs ownership admission, lifecycle cutoff, disabled projection, durable command result, and owner clearance atomically. The service routes disable only through that operation; logout/delete retain cross-store phases. Storage integration verifies terminal disabled state and exact duplicate replay. |

Post-remediation evidence:

- lint and typecheck passed;
- focused credentials/storage/runtime/CLI gate: 6 files, 48 tests passed;
- expanded provider lifecycle process suite: 50 tests passed, including stage unlink-before-flush recovery;
- `pnpm check`: 96 files, 1,096 tests passed; 10 package entry points verified;
- `pnpm test:e2e`: 37 tests passed, including file create/replace/logout/delete, multi-tab convergence, session defaults, and recovery reload;
- local fuzz invocations beginning at seeds `737373` and `737374`: two rounds each passed 11 files and 43 tests;
- `git diff --check`: passed;
- default credential-root inspection: zero files.

A fifteenth fresh independent review remains required. This disposition is implementation evidence, not self-approval.

## Independent local review round 15

The fifteenth fresh review returned **PASS WITH REQUIRED FIXES**. Its confirmed findings and dispositions are:

| Finding | Disposition |
| --- | --- |
| `WI-M11-M1` crash-left credential-root semantic-probe files were not reconciled | **Fixed.** Root initialization now streams a bounded 4,000-entry/10-second cleanup before each semantic probe. It recognizes only strict random `.wi-probe-<32hex>.tmp/.done` names, opens them nonblocking/no-follow, verifies current-user ownership, regular type, one link, exact `0600`, exact size/content, then unlinks and flushes the directory. Lookalikes are preserved and unsafe strict matches fail closed without unlink. A real child is killed with `SIGKILL` after source fsync and after rename; same-root restart removes the residual and passes readiness. |
| `WI-M11-M2` combined browser/process recovery reload crash coverage was absent | **Fixed.** A restartable real-server Playwright fixture now arms process-fatal provider failpoints and preserves the browser's same-origin session storage across restart. Four tests kill after recovery admission, prepare, file observation, and terminal-before-ack; the prior pre-route test remains. Each test proves the journal contains the same safe command ID without `recoveryRef`, reload clears only on the recovered durable status, validating expires safely, and later phases produce exactly one original connection/generation/result. |
| `WI-M11-M3` browser operation-race, closure, run-pinning, and no-fallback coverage was incomplete | **Fixed.** Test-only lifecycle prepare gating now permits a stale second tab to submit disable while replace owns the slot, proving the browser-issued command durably fails `provider.operation_in_progress`; the initiating tab closes, backend work continues, and the remaining tab converges on ready generation 2. A selected slow run then proves future-default change plus disable does not alter its pinned request, while another session pinned to the disabled connection rejects without issuing a request to the healthy alternative; the future run explicitly selected to that alternative succeeds. |

Post-remediation evidence:

- lint and typecheck passed;
- semantic-probe root/process gate: 2 files, 13 tests passed;
- complete Milestone 11 browser suite: 9 tests passed;
- `pnpm check`: 97 files, 1,099 tests passed; 10 package entry points verified;
- `pnpm test:e2e`: 43 tests passed;
- local fuzz invocations beginning at seeds `737373` and `737374`: two rounds each passed 11 files and 43 tests;
- `git diff --check`: passed;
- default credential-root inspection: zero files.

A sixteenth fresh independent review remains required. This disposition is implementation evidence, not self-approval.

## Independent local review round 16

The sixteenth fresh review returned **PASS WITH REQUIRED FIXES**. Its one confirmed finding and disposition is:

| Finding | Disposition |
| --- | --- |
| `WI-M11-M1` exact provider selection depended on a truncated list while registration admitted more than 1,000 rows | **Fixed.** `resolveDefault` now projects the exact `getProviderConnection(connectionId)` result through the strict safe-view schema and never consults the bounded inventory. Milestone 11 now has one coherent hard installation maximum of 1,000 provider connections. Environment registration, file reservation, and recovered-connection reservation each check the total transactionally after exact retry and identity-winner handling but before insertion; the 1,001st distinct row fails with typed `provider.connection_limit_exceeded`. A deterministic integration test fills all 1,000 slots, proves exact retries and exact lookup still work, rejects all three insertion paths without partial rows, and verifies the complete admitted inventory is nontruncated. Runtime coverage injects a failing bounded-list method and proves exact default resolution does not call it. |

Post-remediation evidence:

- lint and typecheck passed;
- focused protocol/storage/runtime gate: 3 files, 32 tests passed;
- `pnpm check`: 97 files, 1,100 tests passed; 10 package entry points verified;
- `pnpm test:e2e`: 43 tests passed;
- local fuzz invocations beginning at seeds `737373` and `737374`: two rounds each passed 11 files and 43 tests;
- `git diff --check`: passed;
- default credential-root inspection: zero files.

A seventeenth fresh independent review remains required. This disposition is implementation evidence, not self-approval.

## Independent local review round 17

The seventeenth fresh review returned **PASS WITH REQUIRED FIXES**. Its one finding and disposition is:

| Finding | Disposition |
| --- | --- |
| `WI-M11-R17-M1` browser provisioning guidance referred to a nonexistent credential-claim HTTP workflow | **Fixed, with premise correction.** The exact source contained no claim-endpoint string, but the panel also did not explain the supported local workflow, so the user-visible outcome was valid. The panel now mirrors the README: use `pnpm credentials:provision` for masked TTY input or `node apps/server/dist/credential-cli.js --api-key-fd 3` for an open descriptor, then paste only the returned `provref_…`. Browser coverage asserts both commands and the paste instruction are visible and that no `credentials/stage` or stage-claim endpoint guidance is rendered. The backend remains GET-only for browser HTTP reads; credential effects continue through WebSocket lifecycle commands. |

Post-remediation evidence:

- lint, typecheck, and build passed;
- focused browser guidance regression: 1 test passed;
- `pnpm check`: 97 files, 1,100 tests passed; 10 package entry points verified;
- `pnpm test:e2e`: 43 tests passed;
- local fuzz invocations beginning at seeds `737373` and `737374`: two rounds each passed 11 files and 43 tests;
- `git diff --check`: passed;
- default credential-root inspection: zero files.

An eighteenth fresh independent review remains required. This disposition is implementation evidence, not self-approval.

## Independent local review round 18

The eighteenth fresh review returned **PASS WITH REQUIRED FIXES**. Its one confirmed finding and disposition is:

| Finding | Disposition |
| --- | --- |
| `WI-M11-R18-H1` restart required the claimed stage before recognizing an already-published exact credential target | **Fixed.** Prepared-operation recovery now inspects the durable target credential before reading claimed staging evidence. If the target internal ref contains the exact reserved envelope, connection, provider, auth mode, generation, and canonical identity, recovery advances durably through `file_observed` to `succeeded` even when the claimed stage was already deleted. If the stage remains readable, recovery still binds its claim fields and compares its API-key material to the published target with constant-time digests, preserving fail-closed detection of secret substitution. Only `credential.stage_missing` is tolerated after the exact target is proved; incomplete or mismatched targets still require the stage for replay or terminalize safely. Real-process regressions crash create, replace, refresh, and reauthenticate after the file effect, delete the claimed stage before restart, and require one stable successful result with the reserved generation, cleared owner, consumed/cleaned claim, and one credential effect. |

Post-remediation evidence:

- lint and typecheck passed;
- focused exact-target/stage-absence process regressions: 5 tests passed, including the retained wrong-secret fail-closed case;
- complete provider lifecycle process suite: 54 tests passed;
- `pnpm check`: 97 files, 1,104 tests passed; 10 package entry points verified;
- `pnpm test:e2e`: 43 tests passed;
- local fuzz invocations beginning at seeds `737373` and `737374`: two rounds each passed 11 files and 43 tests;

A nineteenth fresh independent review remains required. This disposition is implementation evidence, not self-approval.

## Independent local review round 19

The nineteenth fresh review returned **PASS WITH REQUIRED FIXES**. Its one confirmed finding and disposition is:

| Finding | Disposition |
| --- | --- |
| `M11-IR19-001` browser provider polling could overlap without an attempt deadline | **Fixed.** Catalog refresh and recovery reconciliation now share a bounded polling primitive that starts immediately, admits only one active cycle, polls at two-second intervals, aborts a cycle after five seconds, suppresses late results, and aborts active work on cleanup/unmount. Recovery status requests for the journal's bounded entries share the cycle signal and run concurrently within the existing 32-entry browser/server caps. Terminal handling first verifies the journal entry remains present, removes it before notifying, and therefore emits one completion/failure notice even across later polls. Deterministic fake-timer tests prove interval ticks cannot overlap a deferred request, timeout abort precedes retry, terminal reconciliation notifies once, and stop aborts active work and prevents future admission. |

Post-remediation evidence:

- lint and typecheck passed;
- focused bounded-poller and recovery-journal gate: 2 files, 6 tests passed;
- `pnpm check`: 98 files, 1,108 tests passed; 10 package entry points verified;
- `pnpm test:e2e`: 43 tests passed;
- local fuzz invocations beginning at seeds `737373` and `737374`: two rounds each passed 11 files and 43 tests;

A twentieth fresh independent review remains required. This disposition is implementation evidence, not self-approval.

## Independent local review round 20

The twentieth fresh review returned **PASS WITH REQUIRED FIXES**. Its one confirmed Critical finding and disposition is:

| Finding | Disposition |
| --- | --- |
| `WI-M11-C1` restart could accept secret-only replacement of a claimed catalog-loss recovery source | **Fixed.** `FileCredentialStore` now returns bounded nonsecret file identity—decimal device, inode, size, and high-resolution ctime—from pre/post-read `fstat` on the same no-follow validated descriptor used to parse the final claim envelope. Recovery reservation persists that tuple only in the internal lifecycle operation; no path, filename, secret, credential-derived hash, or fingerprint is stored or exposed. Same-process completion and restart both require the tuple plus exact envelope binding. A mismatch enters the existing after-effect recovery failure path, producing `credential.recovery_source_changed`, an unavailable original-generation tombstone, consumed claim, and preserved changed evidence. A real child claims key A, crashes after `after_recovery_prepare`, atomically replaces only API-key bytes while retaining every envelope metadata field, restarts, and proves failed-after-effect tombstoning with the original internal ref and changed file preserved. |

Post-remediation evidence:

- lint and typecheck passed;
- focused file-store/storage/recovery process gate: 3 files, 9 tests passed;
- complete provider lifecycle process suite: 55 tests passed;
- `pnpm check`: 98 files, 1,109 tests passed; 10 package entry points verified;
- `pnpm test:e2e`: 43 tests passed;
- local fuzz invocations beginning at seeds `737373` and `737374`: two rounds each passed 11 files and 43 tests;

A twenty-first fresh independent review remains required. This disposition is implementation evidence, not self-approval.

## Independent local review round 21

The twenty-first fresh review returned **PASS WITH REQUIRED FIXES**. Its one confirmed High finding and disposition is:

| Finding | Disposition |
| --- | --- |
| `WI-M11-H1` claimed staged credential could be replaced after prepare without detection | **Fixed.** `CredentialProvisioner` now returns bounded nonsecret stage identity—decimal device, inode, size, and high-resolution ctime—from pre/post-read `fstat` on the same nonblocking no-follow descriptor that parses the staged envelope. File create/replace and test-only refresh/reauthenticate reservation persist this tuple in the internal lifecycle row in the same catalog transaction that claims the provisioning ID. Every same-process and restart read requires exact descriptor identity plus provisioning/provider/auth binding before API-key publication. No credential-derived hash or fingerprint is stored. An identity mismatch with absent target is a stable pre-effect `credential.binding_mismatch`: owner clears, no credential is published, the claimed stage is cleaned, and existing final evidence remains untouched. Deterministic same-process and real-child tests atomically replace only stage key bytes while preserving all staged-envelope metadata and prove this outcome. |

Post-remediation evidence:

- lint and typecheck passed;
- focused provisioner/runtime/process gate: 3 files, 7 tests passed;
- complete provider lifecycle process suite: 56 tests passed;
- `pnpm check`: 98 files, 1,111 tests passed; 10 package entry points verified;
- `pnpm test:e2e`: 43 tests passed;
- local fuzz invocations beginning at seeds `737373` and `737374`: two rounds each passed 11 files and 43 tests;

A twenty-second fresh independent review remains required. This disposition is implementation evidence, not self-approval.

## Independent local review round 22

The twenty-second fresh review returned **PASS WITH REQUIRED FIXES**. Its four confirmed findings and dispositions are:

| Finding | Disposition |
| --- | --- |
| `WI-M11-R22-H1` catalog-global command IDs were not shared across session creation, provider lifecycle, and provider metadata ledgers | **Fixed.** Catalog reservation now symmetrically checks `catalog_commands`, `provider_lifecycle_operations`, and `provider_metadata_commands` inside every claiming transaction. Session creation, provider lifecycle, and provider metadata therefore share one command-ID namespace: cross-method/content reuse conflicts in either ordering, and concurrent session/provider claims produce exactly one winner and one conflict. Storage regressions cover both sequential orderings and concurrent admission. |
| `WI-M11-R22-H2` disable could commit after preliminary run selection but before the session run-acceptance transaction | **Fixed.** Provider snapshot acceptance now acquires a per-connection process lease, performs final authoritative selection validation while holding it, and retains it until `SessionActor` reports acceptance or rejection. Lifecycle cutoff preparation uses the same connection boundary and waits for earlier acceptance leases. A deterministic runtime race pauses preliminary capability resolution, commits disable, resumes selection, and proves `message.submit` rejects without an accepted command or run projection. Existing direct snapshot fixtures explicitly settle the acceptance lease. |
| `WI-M11-R22-M1` descriptor ingestion decoded each chunk independently and corrupted split UTF-8 sequences | **Fixed.** Credential input now counts raw bytes while feeding one `StringDecoder`; `decoder.end()` flushes once at EOF. Tests split a four-byte code point across chunks and require exact reconstruction, and retain exact-limit acceptance plus one-byte-over rejection. |
| `WI-M11-R22-M2` mountinfo parsing omitted the Linux `\\012` newline escape | **Fixed.** Mount-field decoding now handles `\\012` alongside space, tab, backslash, and carriage-return escapes before mountpoint comparison. A regression supplies an unsafe nested mount whose decoded mountpoint contains a newline and proves longest-match rejection. |

Post-remediation evidence:

- lint and typecheck passed;
- focused four-finding gate: 4 files, 5 tests passed;
- `pnpm check`: 98 files, 1,116 tests passed; 10 package entry points verified;
- `pnpm test:e2e`: 43 tests passed;
- local fuzz invocations beginning at seeds `737373` and `737374`: two rounds each passed 11 files and 43 tests;
- `git diff --check`: passed;
- default credential-root inspection: zero files.

A twenty-third fresh independent review remains required. This disposition is implementation evidence, not self-approval.

## Independent local review round 23

The twenty-third fresh review returned **PASS WITH REQUIRED FIXES**. Its two confirmed Medium findings and dispositions are:

| Finding | Disposition |
| --- | --- |
| `WI-M11-M1` expired recovery epochs retained complete API keys in scanner bindings | **Fixed.** Recovery closure now stores canonical nonsecret metadata plus a keyed HMAC fingerprint rather than `StoredCredential`. The scanner owns a random per-epoch key, schedules cleanup at exact expiry, eagerly expires on claim/status observation, clears bindings, zeroes binding fingerprints and the key buffer, and notifies `ProviderConnectionService` to drop its cached scanner/result. Scan failure also clears key material. A fake-clock regression advances to exact expiry, proves the binding map and callback-owned cache boundary clear, proves captured key/fingerprint buffers are zeroed and contain no synthetic key string, then starts a fresh scan successfully. |
| `WI-M11-M2` occupied connection, authoritative identity, and already-claimed recovery evidence did not preserve the frozen distinct result taxonomy | **Fixed.** Protocol and safe error mapping now define `credential.recovery_connection_conflict`, `credential.recovery_identity_conflict`, and `credential.recovery_already_claimed`. Catalog reservation emits the first two and scanner claim emits the third. Recovery admission persists the exact code before rethrowing, so direct rejection, identical retry, and status agree. Runtime coverage constructs all three real conflicts and verifies one stable code with no second claim/effect; storage and safe-mapping tests cover the lower boundaries. |

Post-remediation evidence:

- lint and typecheck passed;
- focused scanner/conflict gate: 4 files, 37 tests passed;
- complete provider lifecycle process suite: 56 tests passed;
- `pnpm check`: 98 files, 1,120 tests passed; 10 package entry points verified;
- `pnpm test:e2e`: 43 tests passed;
- local fuzz invocations beginning at seeds `737373` and `737374`: two rounds each passed 11 files and 43 tests;
- `git diff --check`: passed;
- default credential-root inspection: zero files.

A twenty-fourth fresh independent review remains required. This disposition is implementation evidence, not self-approval.

## Independent local review round 24

The twenty-fourth fresh review returned **PASS WITH REQUIRED FIXES**. Its one confirmed High finding and disposition is:

| Finding | Disposition |
| --- | --- |
| `WI-M11-H1` recovery status could return final `not_accepted` after a stale initial durable absence even though recovery subsequently succeeded | **Fixed.** Status now projects durable operations through one helper. If the first lifecycle lookup is empty, ingress is drained, and the epoch is closed, it repeats lifecycle and metadata command lookups before returning final `not_accepted`. Closed-epoch admission rejection prevents a later matching recovery from appearing, while the final lookup observes work that admitted and terminalized after the stale first read. A deterministic fixture hook pauses immediately after the first null lookup; the test completes recovery, removes ingress, advances the epoch to expiry, resumes status, and requires the durable `succeeded` result rather than `not_accepted`. |

Post-remediation evidence:

- lint and typecheck passed;
- focused stale-read linearization regression: 1 test passed;
- complete provider lifecycle process suite: 56 tests passed;
- `pnpm check`: 98 files, 1,121 tests passed; 10 package entry points verified;
- `pnpm test:e2e`: 43 tests passed;
- local fuzz invocations beginning at seeds `737373` and `737374`: two rounds each passed 11 files and 43 tests;
- `git diff --check`: passed;
- default credential-root inspection: zero files.

A twenty-fifth fresh independent review remains required. This disposition is implementation evidence, not self-approval.

## Independent local review round 25

The twenty-fifth fresh review returned **PASS WITH REQUIRED FIXES**. Its one confirmed Medium finding and disposition is:

| Finding | Disposition |
| --- | --- |
| `M11-ENV-001` environment-backed credentials bypassed the shared 16,384-byte UTF-8 API-key limit | **Fixed.** `EnvironmentCredentialLeaseManager.value` now measures UTF-8 bytes against `MAXIMUM_API_KEY_BYTES` before both acceptance fingerprinting and every request-boundary fingerprint/issuance. Oversized values throw typed safe `credential.environment_invalid`. Acceptance converts that error for browser routing, durably marks the exact generation/revision connection unavailable, and commits no message/run; request re-read likewise invokes no adapter callback and follows the existing unavailable transition. Unit coverage accepts exact ASCII/multibyte boundaries, rejects one-byte-over variants, and rejects a valid-acceptance→oversized-request transition. The independent property model now generates small/exact/over ASCII and multibyte environment states, and runtime integration verifies typed rejection plus unavailable convergence. |

Post-remediation evidence:

- lint and typecheck passed;
- focused environment unit/property/runtime gate: 3 files, 6 tests passed;
- complete provider lifecycle process suite: 56 tests passed;
- `pnpm check`: 98 files, 1,122 tests passed; 10 package entry points verified;
- `pnpm test:e2e`: 43 tests passed;
- local fuzz invocations beginning at seeds `737373` and `737374`: two rounds each passed 11 files and 43 tests;
- `git diff --check`: passed;
- default credential-root inspection: zero files.

A twenty-sixth fresh independent review remains required. This disposition is implementation evidence, not self-approval.

## Independent local review round 26

The twenty-sixth fresh review returned **PASS WITH REQUIRED FIXES**. Its High and Medium findings and dispositions are:

| Finding | Disposition |
| --- | --- |
| `WI-M11-H1` two distinct commands racing for one staged credential gave the loser a transient SQLite/storage error and no durable result | **Fixed.** File reservation now queries the provisioning claim inside the serialized catalog transaction before creating a connection. If another command owns it, the transaction inserts a terminal failed lifecycle operation for the loser with `credential.provisioning_already_claimed`, no connection/owner/claim/effect, and returns that operation without throwing/rolling back. Exact retry recognizes the failed operation even though its proposed target was never created, so `createFileConnection` returns the same typed result before touching staging evidence. A controlled `afterLifecyclePrepare` race proves one ready generation/file, one durable loser, stable retry after winner stage cleanup, and no second connection/effect. |
| `WI-M11-M1` concurrent calls could both pass one process-local recovery binding before asynchronous rescan | **Fixed.** Each recovery binding now has a `claiming` bit set synchronously after expected-metadata validation and before the first `await`. Concurrent callers receive `credential.recovery_already_claimed`; the owning validation clears `claiming` on failure and transitions to `claimed` only after complete closure succeeds. A gated unit rescan proves exactly one fulfillment, and the runtime conflict test now gates the first command's rescan while a second command is durably admitted/failed, then verifies rejection, retry, and status preserve the same code before and after the winner succeeds. |

Post-remediation evidence:

- lint and typecheck passed;
- focused provisioning/recovery concurrency gate: 2 files, 3 tests passed;
- complete provider lifecycle process suite: 56 tests passed;
- `pnpm check`: 98 files, 1,124 tests passed; 10 package entry points verified;
- `pnpm test:e2e`: 43 tests passed;
- local fuzz invocations beginning at seeds `737373` and `737374`: two rounds each passed 11 files and 43 tests;
- `git diff --check`: passed;
- default credential-root inspection: zero files.

A twenty-seventh fresh independent review remains required. This disposition is implementation evidence, not self-approval.

## Independent local review round 27 remediation

Review target: the uncommitted Milestone 11 tree after the round-27 independent findings `WI-M11-R27-H1` and `WI-M11-R27-M1`.

| Finding | Disposition |
| --- | --- |
| `WI-M11-R27-H1` public recovery-epoch expiry invalidated a verifier returned by a successful claim and could create a false `credential.recovery_source_changed` tombstone | **Fixed.** `CredentialRecoveryScanner.claim()` now returns an independently owned `ClaimedCredentialVerifier` containing cloned keyed fingerprint evidence rather than a closure over scanner state. Scanner expiry/close zeroizes only unused/public bindings; the consumed verifier survives through catalog reservation and final file verification. The service disposes it idempotently and zeroizes its key/fingerprint on every success and failure path after verification. Changed evidence still follows the existing failed-after-effect unavailable tombstone path. |
| `WI-M11-R27-M1` process-wide recovery ingress had no aggregate count/byte budget | **Fixed.** Added a constructor/test-only lowerable, production-fixed budget of 64 pending frames and 512 KiB total bounded raw/canonical command bytes. Browser pre-registration and direct service routing reserve synchronously before ingress insertion; duplicate frames reserve independently; exact reservation handles release once; saturated frames never enter the serialized queue and return safe typed `provider.rate_limited`; epoch-closed frames retain `credential.recovery_ref_expired`; shutdown drains bounded reservations before clearing process state. |

### Deterministic regression evidence

- `packages/credentials/src/recovery.test.ts`: unchanged and changed evidence after public scanner close, explicit idempotent verifier disposal, zeroized owned buffers, and use-after-disposal rejection.
- `tests/integration/provider-connection-runtime.test.ts`: gated after claim/reservation and after durable `file_observed`, advanced the injected clock through expiry, closed the public scanner via a replacement scan, released unchanged final verification, and proved one original ready connection/generation plus stable identical retry.
- `apps/server/src/provider-connections/recovery-ingress.test.ts`: exact frame/byte boundaries, one-over saturation, duplicate reservation accounting, exact release, idempotent release, and constructor override validation.
- `tests/integration/milestone5-server.test.ts`: two authenticated WebSockets fill the service budget while routing is gated; the next valid frame receives immediate `provider.rate_limited`, creates no lifecycle row/effect, direct routing cannot bypass the budget, accepted work releases all accounting, and shutdown drains at zero.

### Final verification

- `pnpm lint` — passed.
- `pnpm typecheck` — passed.
- Focused round-27 suite — 4 files, 123 tests passed.
- `pnpm check` — 99 files, 1,130 tests passed.
- `pnpm test:e2e` — 43 passed.
- `WI_FC_SEED=737373 pnpm test:fuzz` — passed, 11 files/43 tests.
- `WI_FC_SEED=737374 pnpm test:fuzz` — passed, 11 files/43 tests.
- `git diff --check` — passed.
- Default `${XDG_STATE_HOME:-$HOME/.local/state}/wi/credentials` root — 0 entries.

A twenty-eighth fresh independent review is required. This record preserves the round-27 findings and does not self-approve Milestone 11 or authorize Milestone 12.

## Independent local review round 28 remediation

Review target: the uncommitted Milestone 11 tree after independent finding `WI-M11-R28-M1`.

| Finding | Disposition |
| --- | --- |
| `WI-M11-R28-M1` credential final rename, credential unlink, and staged final rename had no direct process-death evidence before containing-directory fsync | **Fixed.** `@wi/credentials` now exposes generic hooks immediately after credential final rename, after credential unlink, and after staged final rename, before their respective post-mutation directory flushes. The server/process-test composition maps them to the closed provider failpoints `after_provider_credential_rename_before_flush` (exit 114), `after_provider_credential_unlink_before_flush` (exit 115), and `after_provider_stage_rename_before_flush` (exit 116). The existing dual test gates and provider-command selector remain mandatory; the controller calls `process.exit` and cannot be activated by browser, catalog, provider, or ordinary production data. |

### Crash outcomes proven

- **Create:** a child dies after final credential rename and before credential-directory fsync. Restart observes the exact complete target when present or uses only the exact claimed stage when publication was not visible, terminalizes one success, and preserves one generation/file with no partial JSON or duplicate claim/effect.
- **Replace:** the same boundary permits exact old or reserved-new complete evidence. Restart observes the exact new target or replays only the exact claimed stage, increments generation once, keeps one target file, and returns the stable original result.
- **Logout and delete:** a child dies after unlink and before directory fsync. Restart reconciles exact absence or the exact old bound envelope through the shared destructive path; logout ends `reauth_required`, delete ends the unavailable/deleted tombstone, and neither repeats a destructive effect or mutates another connection.
- **Stage publication:** a child dies after stage rename and before staging-directory fsync and reference return. No reference/secret reaches child output or `WI_HOME`; restart sees a complete unclaimed stage or no stage, performs bounded cleanup, and creates no connection or claim.

### Regression evidence

- Unit hook-order tests cover the two credential-store namespace hooks and the staged rename hook; failpoint unit tests cover the closed inventory and deterministic exit-code mapping.
- Real-child process regressions use identical roots across restart and assert pre-restart complete-file/absence outcomes, final file counts and bindings, generation, cleared owner, consumed claim, exact retries, distinct logout/delete projections, and synthetic-secret absence from output and `WI_HOME`.
- Focused crash-window tests: 6 passed. Complete provider lifecycle process suite: 66 passed.

### Final gate evidence

- `pnpm lint` — passed.
- `pnpm typecheck` — passed.
- Focused credential unit/hooks — 3 files, 37 tests passed.
- Complete provider lifecycle process suite — 1 file, 66 tests passed.
- `pnpm check` — passed; 100 files, 1,142 tests.
- `pnpm test:e2e` — 43 passed.
- `WI_FC_SEED=737373 pnpm test:fuzz` — passed; 11 files/43 tests per round.
- `WI_FC_SEED=737374 pnpm test:fuzz` — passed; 11 files/43 tests per round.
- `git diff --check` — passed.
- Default `${XDG_STATE_HOME:-$HOME/.local/state}/wi/credentials` root — 0 entries.

A twenty-ninth fresh independent review is required. This record does not self-approve Milestone 11, clear release, or authorize Milestone 12.

## WI-M11-H1 correction evidence

Review target: the uncommitted tree after the remote-review blocker `WI-M11-H1`.

| Finding | Disposition |
| --- | --- |
| `WI-M11-H1` an environment-backed connection that started unavailable, or became unavailable after a missing, changed, or oversized variable, had no accepted path to revalidate the same connection after the value returned | **Fixed.** Added the strict `providerConnection.environment.revalidate` command. The command carries only `commandId`, `connectionId`, expected lifecycle revision, and expected generation. Backend validation resolves the existing environment reference without returning or persisting the value. Catalog `enable` admission accepts only the same undeleted unavailable environment connection, advances lifecycle revision once, preserves generation and identity, and owns the connection until terminal commit. Successful retries return the original durable result. Changed command content conflicts. Competing lifecycle commands receive a durable `provider.operation_in_progress` result. Restart recovery validates the same target before completing a prepared operation. |

### Deterministic old/new traces

The pre-fix traces reproduced both remote failures. The deterministic assertion results were `Expected lifecycleStatus: "ready"; Received lifecycleStatus: "unavailable"` for initial absence, and `provider.connection_unavailable` before credential resolution for post-use invalidation.

- Initial absence: create while the variable was absent, set a valid value, and retry normal work. The connection remained `unavailable` and no existing operation could restore readiness.
- Post-use invalidation: change or oversize the variable after a request boundary, restore the accepted value, and retry. The connection remained `unavailable` and the request was rejected before credential resolution.

The retained corrected regressions now prove the inverse:

- `tests/integration/provider-connection-runtime.test.ts` restores an initially unavailable connection and an invalidated connection, preserves the original ID and generation, rejects missing/invalid input, checks durable duplicate/conflict behavior, and scans catalog/home files for the synthetic value.
- `tests/integration/provider-connections-storage.test.ts` proves `enable` changes only unavailable environment state, increments lifecycle revision once, preserves generation, and rejects ready reuse.
- `tests/process/provider-lifecycle-recovery.test.ts` proves prepared and successful revalidation across child-process restart with zero provider requests.
- `tests/e2e/milestone11-provider-connections.spec.ts` proves two tabs race revalidation, receive durable owner conflict, and converge on the same ready connection.

### Changed files and safety evidence

- Protocol and routing: `packages/protocol/src/commands.ts`, `apps/server/src/websocket/command-router.ts`, `apps/server/src/websocket/durable-command-limits.ts`, and `apps/web/src/socket/command-size.ts`.
- State and service: `packages/credentials/src/environment.ts`, `packages/storage/src/catalog/repository.ts`, `apps/server/src/provider-connections/service.ts`, and `apps/server/src/composition.ts`.
- Browser and tests: `apps/web/src/components/ProviderConnectionsPanel.tsx`, the protocol/credential/lifecycle unit tests, provider runtime/storage integration tests, process fixture/test, and M11 E2E fixture/spec.
- The command creates no credential file, generation, connection, identity claim, or provider request. The runtime test observed zero fake-provider requests. SQLite, `WI_HOME`, browser payloads, and operation results contain no synthetic environment value or fingerprint.

### Verification

- `pnpm --filter @wi/protocol typecheck && pnpm --filter @wi/server typecheck` — passed.
- Focused unit suite — 3 files, 41 tests passed.
- Focused revalidation integration suite — 2 files, 3 tests passed, 29 skipped.
- `pnpm test:unit` — 56 files, 568 tests passed.
- `pnpm test:integration` — 9 files, 298 tests passed.
- `WI_FC_SEED=737373 pnpm test:property` — 16 files, 65 tests passed.
- `pnpm test:process` — 68 files, 108 tests passed in the complete gate.
- `pnpm test:e2e` — 44 tests passed.
- `WI_FC_SEED=737373 pnpm test:fuzz` — two local rounds passed; each round ran 11 files and 43 tests, with seeds 737373 and 737374.
- `pnpm check` — 75 files, 938 tests passed.
- Markdown link validation — 82 files, 115 local targets resolved.
- `git diff --check` — passed.

The tree remains uncommitted and unpushed. No Git transition or hosted-service mutation occurred. A fresh independent exact-tree review remains required; this evidence does not self-approve Milestone 11 or authorize Milestone 12.

# Wi v0.1 security and secret handling

## Trust model

Wi v0.1 is a local tool for one trusted Linux operating-system user. The same user and same-user processes are trusted. Wi does not defend `WI_HOME` against hostile concurrent same-user path/database substitution and is not suitable for internet-facing, remote, multi-user, or multi-tenant hosting.

This boundary is defined by [ADR-0012](adr/0012-trusted-local-user-storage-boundary.md).

## Network boundary

- Production binds exactly to `127.0.0.1`.
- HTTP validates `Host` against the listening loopback origin.
- WebSocket upgrades validate method/path, Host, Origin, `wi.v1` subprotocol, and the local browser credential.
- Planned OAuth callback/tombstone HTTP routes retain strict exact-loopback single-Host and parser/size validation. Top-level provider redirects may omit Origin or carry a cross-site Origin, and may lack a valid Wi browser cookie; neither Origin nor cookie authorizes callback completion. Exact backend attempt state, PKCE, expiry, and redirect contract provide the Milestone 13 authorization boundary.
- Bootstrap establishes an HttpOnly, same-origin credential.
- Provider credentials never enter browser storage, HTML, bootstrap JSON, or WebSocket payloads.
- Browser traces are disabled in E2E because they can retain HttpOnly cookies.
- Browser SSE is not implemented.

Loopback is not a substitute for hostile-user isolation. Other processes owned by the same local user can access user-owned files and may be able to interact with the local service.

## Browser handling

The browser is a temporary view, not the owner of runs or credentials. It keeps only a bounded unresolved-command/draft journal in `sessionStorage`. Provider/model/tool output is rendered as untrusted text; it is not inserted as active HTML. The browser stores no API keys, OAuth tokens, provider tokens, or durable backend state in localStorage, IndexedDB, or application-managed cookies.

Milestone 11 catalog-loss recovery never persists its one-time `recoveryRef` or complete recovery command in that journal. It stores only bounded nonsecret command/epoch reconciliation metadata and, after reload or lost acknowledgement, uses an authenticated non-mutating status read to obtain admission/validation pending, final not-accepted after epoch closure and drained ingress, or the original safe terminal result. The read cannot execute recovery or reveal/infer a reference, and final absence proves the old command cannot later claim evidence.

A socket failure removes subscriptions only. It never implicitly cancels a run. Recovery ingress is bounded process-wide at 64 pending frames and 512 KiB of bounded raw/canonical command bytes across authenticated sockets and direct backend routing; saturated recovery frames receive only a safe typed `provider.rate_limited` rejection and create no durable effect. Public recovery-epoch cleanup invalidates unused references, while an already-consumed claim uses separately owned verifier evidence that is zeroized on disposal through final verification.

## Logs and diagnostics

Server logs are structured, bounded, and redacted:

- sensitive key concepts such as authorization, cookie, password, secret, token, OAuth, and API key are replaced;
- Bearer/Basic/cookie/token-like text is scrubbed;
- URL userinfo, query strings, and fragments are removed;
- raw malformed payloads become length/hash fingerprints;
- arbitrary error messages become bounded fingerprints;
- object depth, entry count, key length, and string length are capped.

Browser-facing errors contain a stable allowlisted code, safe bounded message, and `diagnosticId`. Detailed redacted diagnostics remain server-side.

Do not redirect production logs to a world-readable path. Diagnostic IDs are correlation values, not secrets.

## Storage

`WI_HOME` and generated subdirectories are private to the local user when Wi creates them. Wi does not chmod pre-existing parent directories. Browser input never supplies a session database path; paths derive from validated session IDs under the canonicalized home.

Session databases intentionally contain user messages, assistant output, tool arguments/results, approvals, and other session history. They must not contain provider credentials, browser credentials, OAuth material, authorization headers, or [`CredentialStore`](adr/0014-wsl-file-credential-store.md) data. Milestone 11 stores file credentials outside `WI_HOME` and supports read-only environment references; neither backend places secrets in SQLite.

The catalog contains summaries and location/index data, not provider secrets. Session event history is append-only. Corrupt or unsupported evidence is preserved in place rather than automatically deleted or overwritten. Complete-catalog-loss credential recovery exposes only bounded safe metadata and a backend-issued opaque one-time recovery reference to the authenticated local administration flow; it never exposes or accepts a credential path, generated filename, secret, or credential-derived fingerprint.

## Provider and tools

Milestone 11 handles OpenAI Platform API-key credentials only inside the local file/environment `CredentialStore` boundary; selected-provider execution remains a deterministic test-gated no-network fixture. There is:

- no OpenAI API request, endpoint probe, or live adapter;
- no ChatGPT/Codex OAuth;
- no provider/account/billing fallback;
- no `codex app-server` invocation;
- no real shell execution;
- no general filesystem mutation tool;
- no plugin execution.

Every tool call is validated and recorded in the durable ledger. A partial, failed, cancelled, incomplete, or nonterminal provider response cannot authorize execution. Ambiguous non-idempotent effects become `outcome_unknown` and are never retried automatically.

## Backup/export

No production session-export API or UI exists. A future export must use a consistent SQLite snapshot and exclude API keys, OAuth tokens, browser credentials, and `CredentialStore` material. Current v0.1 manual backups should be performed while Wi is stopped and treated as sensitive because session content is included; v0.2 credentials live outside the `WI_HOME` backup boundary.

## Reporting a local diagnostic

When sharing diagnostics:

1. prefer the safe browser code and `diagnosticId`;
2. inspect server logs locally;
3. do not upload an entire `WI_HOME`, database, WAL/SHM file, browser profile, or environment dump;
4. remove user/model/tool content and local paths unless explicitly required;
5. verify property counterexample artifacts before sharing, even though their writers bound and redact content by design.

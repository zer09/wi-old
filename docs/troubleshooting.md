# Wi v0.1 plus v0.2 Milestone 11 troubleshooting

## Server does not start

### Unsupported platform or runtime

Wi requires Linux, Node.js 24, and pnpm 11:

```sh
uname -s
node --version
pnpm --version
```

Use the repository-pinned versions; do not bypass `preinstall` checks.

### Port already in use

The default port is `4317`. Select another loopback port:

```sh
WI_PORT=4318 pnpm start
```

Or use `WI_PORT=0` and read the JSON `server_started` log record for the selected port.

### Browser build missing

The production server serves `apps/web/dist`. Rebuild before starting:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

### Invalid configuration

Configuration errors are emitted as bounded redacted startup diagnostics. Check values against [the operational reference](reference/operational-limits.md). Empty `WI_HOME`, nonnumeric ports/timeouts, out-of-range discovery limits, and any `WI_CATALOG_REPAIR` value other than `1` fail before normal startup.

## Browser cannot connect

- Open the exact loopback origin reported by `server_started`.
- Do not substitute a LAN hostname or non-loopback address.
- Reload once to establish a fresh HttpOnly bootstrap credential after backend restart.
- Check that a proxy or extension is not rewriting `Host`, `Origin`, cookies, or the `wi.v1` WebSocket subprotocol.
- Browser errors include a `diagnosticId`; correlate it with local server logs.

Repeated abnormal pre-welcome failures trigger a bounded bootstrap credential refresh. Pending commands retain their original command IDs during reconnection.

## Session is replaying, reconnecting, or reports a gap

Wait for `Session state: live`. Wi registers the subscriber, captures a durable head, replays historical pages, sends `replay.complete`, then drains queued live events.

A recoverable transport/query failure retries. Sequence/content identity conflicts are fatal integrity errors and are not cleared by blind replay. Preserve the `diagnosticId` and database evidence.

## Session is unavailable

The catalog can remain healthy while one session is missing, corrupt, unsupported, or migration-failed. Do not delete or overwrite the database.

1. stop Wi;
2. back up the entire `WI_HOME` including WAL/SHM sidecars;
3. inspect redacted logs and the session's unavailable classification;
4. use `WI_CATALOG_REPAIR=1` only for catalog reconstruction—not to rewrite a corrupt canonical session database.

See [migrations and repair](reference/migrations.md).

## Catalog is missing or stale

A stale catalog projection may reconcile automatically from the canonical session head. If the catalog is healthy, missing, or deliberately relocated and explicit reconstruction is required:

```sh
WI_CATALOG_REPAIR=1 pnpm start
```

`WI_CATALOG_REPAIR=1` does not replace or rewrite an existing catalog that SQLite cannot open. Wi preserves that catalog and fails startup closed. With Wi stopped, first back up the entire `WI_HOME`, including `catalog.sqlite3`, `catalog.sqlite3-wal`, and `catalog.sqlite3-shm` when present. Then either restore a known-good catalog or deliberately relocate the catalog and its sidecars outside `WI_HOME`; the next missing-catalog startup can reconstruct session-index rows. Do not delete the only copy of the corrupt files.

Run only one Wi process against that home. Reconstruction is bounded and preserves unavailable session evidence. Project registration metadata may require restoration from a full backup.

## Provider connection or credential is unavailable

Milestone 11 provider management is local and fake/no-network. It does not test an OpenAI endpoint or silently choose another connection.

- For an environment connection, verify the configured variable is nonempty **before starting Wi**. A changed or missing value during a request durably marks that connection unavailable; create or explicitly reauthenticate a connection rather than changing it behind an accepted run.
- For file credentials, run `pnpm build`, then use `pnpm credentials:provision` for masked TTY input. For an already-open descriptor use the direct entrypoint `node apps/server/dist/credential-cli.js --api-key-fd 3 3<key-file`; package-manager wrappers may close descriptor 3.
- Credential and staging roots must remain outside `WI_HOME`, mode `0700`, on a supported Linux filesystem. `/mnt/c` and Windows-backed mounts are rejected.
- `provider.operation_in_progress` identifies the durable winning lifecycle command. Do not invent a new generation or edit credential files; retry the same command content/ID or wait for startup reconciliation.
- `credential.recovery_source_changed` means a claimed catalog-loss source changed before observation. Wi retains an unavailable recovery tombstone and will not guess. Provision a new key and use explicit replacement.
- Catalog-loss recovery is offered only when the provider catalog is empty and retained credential envelopes exist. Recovery references are process/scan-bound and never belong in browser storage.

See [provider operational limits](reference/operational-limits.md) and the [failure/recovery matrix](architecture/failure-recovery-matrix.md).

## A run remains waiting

`waiting_for_user` is durable. Reopen the session and resolve its approval or input. Browser closure does not cancel it. If the backend restarted, actor adoption restores the pending interaction before accepting a resolution.

Only the first valid resolution wins. A second tab may report `approval.already_resolved` or the corresponding input conflict.

## A tool reports `outcome_unknown`

Wi cannot prove whether an interrupted non-idempotent effect occurred. It deliberately does not retry automatically. Inspect the external system or effect manually and resolve operationally; do not edit the SQLite ledger.

## Slow-consumer disconnect

Wi disconnects a browser that exceeds bounded outbound/replay queues rather than dropping durable events. The browser should reconnect and replay from its last trusted cursor. Persistent recurrence usually indicates a suspended/overloaded tab or extension/proxy interference.

## Test failure reproduction

For ordinary tests, rerun the narrow command printed by Vitest/Playwright. For property failures, use the exact seed/path command printed in the error or `.artifacts/fuzz/*.json`:

```sh
WI_FC_SEED=<seed> WI_FC_PATH=<path> pnpm exec vitest run \
  --workspace vitest.workspace.ts --project property <file> -t '<literal title>'
```

Build test dependencies first in a fresh checkout:

```sh
pnpm install --frozen-lockfile
pnpm build:test-deps
```

Counterexample artifacts are mode `0600`, Git-ignored, and uploaded only on failed nightly/manual fuzz workflows.

## Safe diagnostic sharing

Do not share an entire database, `WI_HOME`, environment dump, browser profile, network trace, cookie, authorization header, or raw model/tool content. Start with the safe error code and `diagnosticId`; inspect and redact local logs before sharing anything else.

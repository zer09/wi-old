# Wi database migrations and repair

Wi owns one catalog database and one canonical database per session. They have independent version sequences and never share a transaction.

## Current versions

| Database | Current `PRAGMA user_version` | Migration source |
|---|---:|---|
| Catalog | 6 | `packages/storage/src/catalog/migrations.ts` |
| Session | 5 | `packages/storage/src/session/migrations.ts` |

Migration SQL is copied into the built storage package by `scripts/copy-storage-sql.mjs`; `pnpm build` verifies package entry points afterward.

## Catalog history

| Version | Change |
|---:|---|
| 1 | Initial projects, sessions, and global `session.create` command ledger |
| 2 | Global-command failure code/message, diagnostic ID, and historical quarantine path columns |
| 3 | Transactional `catalog_repair_state` marker with `catalog_new`, `catalog_corrupt`, or `explicit` reason |
| 4 | Per-session `recovery_candidate` plus recovery-candidate index |
| 5 | Nullable historical `unavailable_reason`; current policy preserves unavailable databases in place |
| 6 | Provider connections, authoritative identity claims, capability snapshots, exclusive lifecycle-operation owners, provisioning/recovery claims, metadata-command idempotency, shared catalog-global command-ID ownership across session creation/provider lifecycle/provider metadata ledgers, catalog revision state, and internal nonsecret staged/recovery descriptor identity; no provider secrets or credential-derived hashes |

Catalog migrations run before normal catalog use. A catalog migration failure prevents normal startup because listing and locating sessions cannot be trusted. Wi preserves the original database and sidecars rather than silently overwriting evidence.

## Session history

| Version | Change |
|---:|---|
| 1 | Initial manifest, append-only events, accepted commands, runs/messages/parts/provider steps, tool ledger, approvals, and pending inputs |
| 2 | Adds `tool_call_occurrences`, indexes it by call, and backfills one occurrence from every existing tool execution |
| 3 | Adds nullable `provider_steps.diagnostic_id` |
| 4 | Adds singleton `creation_provenance` for reconstructing the original accepted `session.create` identity |
| 5 | Adds immutable provider-selection snapshots and provider-chain IDs to runs, plus the singleton future-run provider default projection |

Every session migration updates `manifest.schema_version` in the same transaction as its schema change. Retained v1-v4 databases are tested. Frozen prior-version SQL fixtures independent of the current migration arrays prove catalog v5→v6 and session v4→v5 migration with representative retained rows. Injected v6/v5 DDL failures prove rollback preserves the old version and data before a successful retry; the retained v3 fixture continues to prove the same property for v3→v4.

Older retained sessions without v4 creation provenance can rebuild catalog session rows, but cannot reconstruct an already-lost original `session.create` command ID.

## Lazy migration

Ordinary startup does not open and migrate every session database:

1. the catalog supplies the bounded session index;
2. nonterminal recovery candidates may be opened for actor adoption;
3. other session databases open and migrate only when selected or explicitly repaired.

Read-only catalog reconstruction discovers retained session schemas without migration and without creating WAL/SHM files. Discovery is bounded and rejects unsupported newer schemas, oversized databases, invalid manifests, and inconsistent event heads.

## Catalog repair

Normal startup uses automatic repair only when startup state requires it. To explicitly rebuild the catalog index from session manifests:

```sh
WI_CATALOG_REPAIR=1 pnpm start
```

Operational rules:

- stop every other Wi process using the same `WI_HOME` first;
- keep a backup of `catalog.sqlite3`, `catalog.sqlite3-wal`, and `catalog.sqlite3-shm` when investigating corruption;
- `WI_CATALOG_REPAIR=1` repairs a healthy catalog or reconstructs a missing catalog, but does not replace an existing catalog that SQLite cannot open;
- for an unopenable catalog, preserve the stopped-home backup, then restore a known-good catalog or deliberately relocate the catalog and sidecars outside `WI_HOME` before using the missing-catalog reconstruction path;
- repair scans bounded generated session paths only;
- session databases remain canonical;
- missing sessions become `missing` catalog rows;
- corrupt, unsupported, oversized, or provenance-invalid sessions become unavailable and stay in place;
- healthy sessions remain usable even when another session is unavailable;
- project registration metadata is not reconstructable solely from session manifests in v0.1.

A failed catalog observation after a session commit may temporarily leave the catalog stale. Reconciliation reads the canonical session head and applies a monotonic projection update later.

## Backup and restore

There is no production backup/export command in this slice.

For a conservative filesystem backup:

1. stop Wi cleanly;
2. copy the entire `WI_HOME`, including `catalog.sqlite3`, every session directory, and any WAL/SHM sidecars that remain;
3. preserve file permissions;
4. restore to a private directory owned by the same local user;
5. start with the normal automatic mode first; use explicit repair only when the catalog is missing or known stale/corrupt.

Copying only `catalog.sqlite3` is not a session backup. Copying only session databases loses project registration metadata and may require catalog reconstruction.

## Failure behavior

- Migrations are ordered, deterministic, and transactional where SQLite supports it.
- A failed session migration marks the smallest session fault domain unavailable.
- A failed catalog migration blocks catalog-dependent startup.
- Corrupt or unsupported files are preserved in place.
- Wi does not automatically quarantine, delete, overwrite, or downgrade databases.
- Newer schema versions are not opened by older Wi binaries.

See [the storage model](../architecture/storage-model.md) and [failure/recovery matrix](../architecture/failure-recovery-matrix.md).

# PMB local-to-cloud sync

This adapter mirrors a reviewed PMB JSON export into Universal AI Memory. PMB remains authoritative and local-first; the adapter does not open or modify `events.sqlite` or `vectors.lance`.

## 1. Export one PMB workspace

```bash
pmb export --format json --out pmb-export.json
```

PMB stores workspaces under `~/.pmb/workspaces/<workspace-id>/`; each has `events.sqlite` and a neighbouring `vectors.lance` directory. Export each workspace separately. The export command excludes archived events unless `--include-archived` is explicitly used; this adapter intentionally skips archived events.

## 2. Review the export

Open `pmb-export.json` and review records before syncing. Do not upload passwords, API keys, bearer tokens, payment credentials, medical details, political/religious beliefs, government identifiers or third-party sensitive data. Automated keyword filtering cannot reliably detect all sensitive content.

## 3. Configure the bridge

Use the PMB Sync Bridge token issued for your Universal AI Memory project. Store it in an environment variable or your operating system's secret store; do not paste it into source files or commit it.

```bash
export UNIVERSAL_MEMORY_SYNC_URL="https://<project-ref>.supabase.co/functions/v1/sukuma-memory-sync"
export PMB_SYNC_TOKEN="<PMB sync bearer token>"
```

## 4. Dry run, then apply

```bash
python -m integrations.pmb_sync pmb-export.json
```

The default is a dry run. If counts and target workspace are correct, and you manually reviewed the export:

```bash
python -m integrations.pmb_sync pmb-export.json --target-workspace sukuma --apply --reviewed
```

If no target is supplied, the cloud workspace defaults to `pmb-<local-workspace-id>` to preserve isolation. Choose `sukuma`, `amplify`, `nexo`, or another workspace only after confirming the contents belong there.

The adapter batches up to 50 records, uses stable IDs (`pmb:<workspace-id>:<ulid>`), and maintains a local fingerprint state file at `~/.pmb/universal-memory-sync-state.json`. It retries safely because cloud writes are idempotent. It only sends records that changed since the previous successful sync.

## Scope and limitations

- One-way mirror: PMB local SQLite is the source of truth; cloud changes are not written back into PMB.
- No automatic background schedule is installed. Run export and sync when needed.
- No PMB data is uploaded until `--apply --reviewed` is supplied.
- PMB's graph and LanceDB embeddings remain local. Cloud search currently uses PostgreSQL full-text/keyword search; vector embeddings are not yet mirrored.
- This is an optional adapter around PMB's public export format; it does not modify or fork the PMB project.

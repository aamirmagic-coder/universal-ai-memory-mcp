# Universal AI Memory MCP

Owner-controlled shared memory for multiple AI assistants and projects. Supabase is the shared cloud store; PMB remains the local-first SQLite/LanceDB memory engine and sync source.

## Status

- Supabase schema and two Edge Functions are deployed and smoke-tested at the database layer.
- The MCP server exposes search, save, list, stats and soft-archive tools over Streamable HTTP.
- The Sukuma compatibility endpoint accepts upsert/archive requests.
- PMB's actual local sync adapter is not yet implemented in this repository; its SQLite database remains authoritative until that adapter is installed.
- The current search implementation is PostgreSQL full-text/keyword search. pgvector is enabled, but embeddings and semantic search are not yet wired in.
- ChatGPT custom MCP availability depends on the account plan and client surface.

## Architecture

- `private.memory_records`: durable facts, decisions, lessons, projects, preferences and notes.
- `private.memory_entities` / `private.memory_relations`: entity graph primitives.
- `private.memory_clients`: SHA-256 token hashes, permissions and workspace allowlists.
- `private.memory_access_audit`: client/action/workspace access log.
- `universal-memory`: MCP Streamable HTTP endpoint.
- `sukuma-memory-sync`: compatibility REST endpoint for the Sukuma memory integration.
- Workspaces isolate `personal`, `sukuma`, `amplify`, `nexo`, `ward52`, and other project contexts.

## Deploy to Supabase

1. Create a Supabase project and keep its service-role key server-side.
2. Apply `supabase/migrations/20261103000000_universal_memory_core.sql`.
3. Deploy `supabase/functions/universal-memory/index.ts` and `supabase/functions/sukuma-memory-sync/index.ts` with `verify_jwt = false`. The functions perform their own bearer-token authentication against SHA-256 token hashes.
4. Supabase Edge Functions provide `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in their server environment. Never put the service-role key in an MCP client, browser, or repository.
5. Generate random client tokens (e.g. `openssl rand -hex 32` with a prefix), store only their SHA-256 hashes in `private.memory_clients`, and give each client only the permissions/workspaces it needs.
6. Configure the MCP client with the Streamable HTTP endpoint:
   `https://<project-ref>.supabase.co/functions/v1/universal-memory`
   Use HTTP Bearer authentication. Do not commit the token.

Example client registration (replace placeholders in a trusted SQL session):
```sql
insert into private.memory_clients
  (client_name, owner_id, token_hash, permissions, allowed_workspaces)
values
  ('client-name', 'owner-id', '<64-char-sha256-hex>',
   array['memory_search','memory_save','memory_archive','memory_list','memory_stats'],
   array['personal','sukuma']);
```

## MCP tools

- `memory_search`: full-text search in one workspace.
- `memory_save`: idempotent upsert by owner/workspace/external ID.
- `memory_list`: list recent records, including archived records.
- `memory_stats`: counts by type and archive state.
- `memory_archive`: soft archive only; permanent deletion is not exposed through MCP.

## Sukuma compatibility API

POST to `https://<project-ref>.supabase.co/functions/v1/sukuma-memory-sync` with a bearer token and JSON:
```json
{
  "operation": "upsert",
  "external_id": "stable-record-id",
  "workspace_id": "sukuma",
  "memory_type": "decision",
  "content": "Approved project decision",
  "tags": ["project", "decision"]
}
```
For `operation: "delete"`, the endpoint soft-archives the record rather than hard-deleting it.

## PMB integration

PMB remains local-first. Its SQLite store is the source of truth; LanceDB remains its local vector index. A sync adapter should use a durable outbox, stable record IDs, conflict timestamps, retry/backoff, and a tombstone/archive mapping. Do not replace or overwrite PMB's local database with cloud data. Do not upload credentials or sensitive personal data.

## Security and privacy

See [SECURITY.md](SECURITY.md). This service is designed for one owner with workspace-scoped client permissions; it is not a public multi-tenant memory SaaS.

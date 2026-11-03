# Universal AI Memory MCP

Owner-controlled shared memory for multiple AI assistants and projects. Supabase is the shared cloud store; PMB remains the local-first SQLite/LanceDB memory engine and sync source.

## Status

- Supabase schema and two Edge Functions are deployed; database smoke tests passed.
- The MCP server exposes search, save, list, stats and soft-archive tools over Streamable HTTP.
- The compatibility sync endpoint supports single and batched upsert/archive operations.
- A reviewed, one-way PMB export adapter is included. It does not modify PMB local data and requires an explicit apply flag.
- The current cloud search implementation is PostgreSQL full-text/keyword search. pgvector is enabled, but embeddings and semantic search are not yet wired in.
- ChatGPT custom MCP availability depends on the account plan and client surface.

## Architecture

- `private.memory_records`: durable facts, decisions, lessons, projects, preferences and notes.
- `private.memory_entities` / `private.memory_relations`: entity graph primitives.
- `private.memory_clients`: SHA-256 token hashes, permissions and workspace allowlists.
- `private.memory_access_audit`: client/action/workspace access log.
- `universal-memory`: MCP Streamable HTTP endpoint.
- `sukuma-memory-sync`: compatibility REST endpoint for the Sukuma workspace and PMB batch sync.
- Workspaces isolate personal data, project contexts and future workspaces.

## Deploy to Supabase

1. Create a Supabase project and keep its service-role key server-side.
2. Apply `supabase/migrations/20261103000000_universal_memory_core.sql`.
3. Deploy the two functions with `verify_jwt = false`. They perform their own bearer-token authentication against SHA-256 token hashes.
4. Supabase Edge Functions provide `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in their server environment. Never put the service-role key in an MCP client, browser, or repository.
5. Generate random client tokens, store only SHA-256 hashes in `private.memory_clients`, and grant the minimum required permissions and workspace allowlist.
6. Configure MCP clients with `https://<project-ref>.supabase.co/functions/v1/universal-memory` and HTTP Bearer authentication.

## MCP tools

- `memory_search`: full-text search in one workspace.
- `memory_save`: idempotent upsert by owner/workspace/external ID.
- `memory_list`: list recent records, including archived records.
- `memory_stats`: counts by type and archive state.
- `memory_archive`: soft archive only; permanent deletion is not exposed through MCP.

## PMB integration

See [docs/PMB_SYNC.md](docs/PMB_SYNC.md). Export each PMB workspace to JSON, review it, run a dry-run, then explicitly apply. PMB's SQLite remains the source of truth; cloud sync is one-way and opt-in.

## Security and privacy

See [SECURITY.md](SECURITY.md). This service is designed for one owner with workspace-scoped client permissions; it is not a public multi-tenant memory SaaS.

-- Re-assert the private-schema boundary and RLS hardening.
-- Safe to run more than once; no public Data API grants are introduced.
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;
alter table private.memory_clients enable row level security;
alter table private.memory_records enable row level security;
alter table private.memory_entities enable row level security;
alter table private.memory_relations enable row level security;
alter table private.memory_access_audit enable row level security;
revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all sequences in schema private from public, anon, authenticated;

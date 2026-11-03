-- Ensure the owner MCP client can soft-archive memories.
-- This is a no-op if the owner client has not yet been registered.
update private.memory_clients
set permissions = array(
  select distinct permission
  from unnest(permissions || array['memory_archive']::text[]) as permission
)
where client_name = 'Primary Owner MCP'
  and not ('memory_archive' = any(permissions));

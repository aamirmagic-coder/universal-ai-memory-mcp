create extension if not exists vector with schema extensions;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table private.memory_clients (
 id uuid primary key default gen_random_uuid(), client_name text not null, owner_id text not null,
 token_hash text not null unique check(token_hash ~ '^[0-9a-f]{64}$'),
 permissions text[] not null, allowed_workspaces text[] not null, active boolean not null default true,
 created_at timestamptz not null default now(), last_used_at timestamptz, expires_at timestamptz,
 metadata jsonb not null default '{}'::jsonb
);
create table private.memory_records (
 id uuid primary key default gen_random_uuid(), owner_id text not null, workspace_id text not null,
 external_id text not null, memory_type text not null check(memory_type in ('fact','decision','lesson','event','goal','note','project','preference')),
 content text not null check(length(content) between 1 and 20000), tags text[] not null default '{}',
 metadata jsonb not null default '{}'::jsonb, importance numeric(4,3) not null default 0.5 check(importance between 0 and 1),
 confidence numeric(4,3) not null default 1 check(confidence between 0 and 1), is_pinned boolean not null default false,
 source_created_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 archived_at timestamptz, search_vector tsvector generated always as (to_tsvector('simple',content)) stored,
 unique(owner_id,workspace_id,external_id)
);
create index memory_records_owner_workspace_updated_idx on private.memory_records(owner_id,workspace_id,updated_at desc);
create index memory_records_search_idx on private.memory_records using gin(search_vector);
create index memory_records_tags_idx on private.memory_records using gin(tags);
create table private.memory_entities (
 id uuid primary key default gen_random_uuid(), owner_id text not null, workspace_id text not null,
 entity_key text not null, entity_type text not null, display_name text not null,
 attributes jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(), unique(owner_id,workspace_id,entity_key)
);
create table private.memory_relations (
 id uuid primary key default gen_random_uuid(), owner_id text not null, workspace_id text not null,
 source_entity_id uuid not null references private.memory_entities(id) on delete cascade,
 relation_type text not null, target_entity_id uuid not null references private.memory_entities(id) on delete cascade,
 metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(),
 unique(owner_id,workspace_id,source_entity_id,relation_type,target_entity_id)
);
create table private.memory_access_audit (
 id bigint generated always as identity primary key, client_id uuid references private.memory_clients(id) on delete set null,
 owner_id text not null, action text not null, workspace_id text not null, external_id text,
 metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create index memory_access_audit_created_idx on private.memory_access_audit(created_at desc);
create index memory_access_audit_owner_workspace_idx on private.memory_access_audit(owner_id,workspace_id,created_at desc);

alter table private.memory_clients enable row level security;
alter table private.memory_records enable row level security;
alter table private.memory_entities enable row level security;
alter table private.memory_relations enable row level security;
alter table private.memory_access_audit enable row level security;
revoke all on all tables in schema private from public,anon,authenticated;
revoke all on all sequences in schema private from public,anon,authenticated;
create policy memory_clients_service_role on private.memory_clients for all to service_role using(true) with check(true);
create policy memory_records_service_role on private.memory_records for all to service_role using(true) with check(true);
create policy memory_entities_service_role on private.memory_entities for all to service_role using(true) with check(true);
create policy memory_relations_service_role on private.memory_relations for all to service_role using(true) with check(true);
create policy memory_access_audit_service_role on private.memory_access_audit for all to service_role using(true) with check(true);

create or replace function public.resolve_memory_client(p_token_hash text)
returns table(id uuid,owner_id text,permissions text[],allowed_workspaces text[])
language plpgsql security definer set search_path=''
as $$ begin
 return query update private.memory_clients c set last_used_at=pg_catalog.now()
 where c.token_hash=p_token_hash and c.active=true and (c.expires_at is null or c.expires_at>pg_catalog.now())
 returning c.id,c.owner_id,c.permissions,c.allowed_workspaces;
end; $$;

create or replace function public.sync_memory_record(
 p_owner_id text,p_external_id text,p_workspace_id text,p_memory_type text,p_content text,
 p_tags text[],p_metadata jsonb,p_importance numeric,p_confidence numeric,p_is_pinned boolean,p_source_created_at timestamptz
) returns jsonb language plpgsql security definer set search_path=''
as $$ declare v_row private.memory_records; begin
 if p_owner_id is null or p_external_id is null or p_workspace_id is null then raise exception 'owner, external id and workspace required'; end if;
 if p_memory_type not in ('fact','decision','lesson','event','goal','note','project','preference') then raise exception 'invalid memory type'; end if;
 if p_content is null or length(p_content)<1 or length(p_content)>20000 then raise exception 'invalid content length'; end if;
 insert into private.memory_records(owner_id,external_id,workspace_id,memory_type,content,tags,metadata,importance,confidence,is_pinned,source_created_at,updated_at)
 values(p_owner_id,p_external_id,p_workspace_id,p_memory_type,p_content,coalesce(p_tags,'{}'),coalesce(p_metadata,'{}'::jsonb),
 greatest(0,least(1,coalesce(p_importance,0.5))),greatest(0,least(1,coalesce(p_confidence,1))),coalesce(p_is_pinned,false),p_source_created_at,pg_catalog.now())
 on conflict(owner_id,workspace_id,external_id) do update set memory_type=excluded.memory_type,content=excluded.content,tags=excluded.tags,
 metadata=excluded.metadata,importance=excluded.importance,confidence=excluded.confidence,is_pinned=excluded.is_pinned,
 source_created_at=coalesce(excluded.source_created_at,private.memory_records.source_created_at),
 updated_at=pg_catalog.now(),archived_at=null returning * into v_row;
 return pg_catalog.to_jsonb(v_row);
end; $$;

create or replace function public.search_memory_records(p_owner_id text,p_workspace_id text,p_query text,p_limit integer)
returns jsonb language sql security definer set search_path=''
as $$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x)),'[]'::jsonb) from (
 select r.id,r.external_id,r.workspace_id,r.memory_type,r.content,r.tags,r.metadata,r.importance,r.confidence,r.is_pinned,r.source_created_at,r.created_at,r.updated_at
 from private.memory_records r where r.owner_id=p_owner_id and r.workspace_id=p_workspace_id and r.archived_at is null
 and (nullif(pg_catalog.btrim(coalesce(p_query,'')),'') is null or r.search_vector @@ pg_catalog.plainto_tsquery('simple',p_query)
 or r.content ilike '%'||p_query||'%' or r.tags @> array[p_query])
 order by r.is_pinned desc,r.importance desc,r.updated_at desc limit greatest(1,least(coalesce(p_limit,10),50))
) x; $$;

create or replace function public.list_memory_records(p_owner_id text,p_workspace_id text,p_memory_type text,p_limit integer)
returns jsonb language sql security definer set search_path=''
as $$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x)),'[]'::jsonb) from (
 select r.id,r.external_id,r.workspace_id,r.memory_type,r.content,r.tags,r.metadata,r.importance,r.confidence,r.is_pinned,r.source_created_at,r.created_at,r.updated_at,r.archived_at
 from private.memory_records r where r.owner_id=p_owner_id and r.workspace_id=p_workspace_id
 and (p_memory_type is null or r.memory_type=p_memory_type) order by r.updated_at desc limit greatest(1,least(coalesce(p_limit,50),100))
) x; $$;

create or replace function public.get_memory_stats(p_owner_id text,p_workspace_id text)
returns jsonb language sql security definer set search_path=''
as $$ select pg_catalog.jsonb_build_object('total',count(*),'active',count(*) filter(where archived_at is null),
 'archived',count(*) filter(where archived_at is not null),'pinned',count(*) filter(where is_pinned and archived_at is null),
 'by_type',coalesce((select pg_catalog.jsonb_object_agg(t.memory_type,t.cnt) from
 (select memory_type,count(*) cnt from private.memory_records where owner_id=p_owner_id and workspace_id=p_workspace_id group by memory_type)t),'{}'::jsonb))
 from private.memory_records where owner_id=p_owner_id and workspace_id=p_workspace_id; $$;

create or replace function public.archive_memory_record(p_owner_id text,p_external_id text,p_workspace_id text)
returns jsonb language plpgsql security definer set search_path=''
as $$ declare v_count integer; begin
 update private.memory_records set archived_at=pg_catalog.now(),updated_at=pg_catalog.now()
 where owner_id=p_owner_id and external_id=p_external_id and workspace_id=p_workspace_id and archived_at is null;
 get diagnostics v_count=row_count; return pg_catalog.jsonb_build_object('archived',v_count>0,'count',v_count);
end; $$;

create or replace function public.record_memory_access(p_client_id uuid,p_owner_id text,p_action text,p_workspace_id text,p_external_id text,p_metadata jsonb)
returns void language sql security definer set search_path=''
as $$ insert into private.memory_access_audit(client_id,owner_id,action,workspace_id,external_id,metadata)
 values(p_client_id,p_owner_id,p_action,p_workspace_id,p_external_id,coalesce(p_metadata,'{}'::jsonb)); $$;

revoke all on function public.resolve_memory_client(text) from public,anon,authenticated;
revoke all on function public.sync_memory_record(text,text,text,text,text,text[],jsonb,numeric,numeric,boolean,timestamptz) from public,anon,authenticated;
revoke all on function public.search_memory_records(text,text,text,integer) from public,anon,authenticated;
revoke all on function public.list_memory_records(text,text,text,integer) from public,anon,authenticated;
revoke all on function public.get_memory_stats(text,text) from public,anon,authenticated;
revoke all on function public.archive_memory_record(text,text,text) from public,anon,authenticated;
revoke all on function public.record_memory_access(uuid,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.resolve_memory_client(text) to service_role;
grant execute on function public.sync_memory_record(text,text,text,text,text,text[],jsonb,numeric,numeric,boolean,timestamptz) to service_role;
grant execute on function public.search_memory_records(text,text,text,integer) to service_role;
grant execute on function public.list_memory_records(text,text,text,integer) to service_role;
grant execute on function public.get_memory_stats(text,text) to service_role;
grant execute on function public.archive_memory_record(text,text,text) to service_role;
grant execute on function public.record_memory_access(uuid,text,text,text,text,jsonb) to service_role;

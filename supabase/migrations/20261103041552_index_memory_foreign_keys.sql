create index if not exists memory_access_audit_client_id_idx on private.memory_access_audit(client_id);
create index if not exists memory_relations_source_entity_id_idx on private.memory_relations(source_entity_id);
create index if not exists memory_relations_target_entity_id_idx on private.memory_relations(target_entity_id);

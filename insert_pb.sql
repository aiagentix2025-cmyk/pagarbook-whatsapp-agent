-- Insert integration for PocketBase SQLite (matching exact nc_integrations_v2 schema)
INSERT INTO nc_integrations_v2 (id, title, config, type, sub_type, created_by, fk_workspace_id, is_private, deleted, is_default, is_encrypted, is_global, "order")
VALUES (
  'intpocketbase001',
  'pocketbase_db',
  '{"client":"sqlite3","connection":{"filename":"/usr/app/pb_data/data.db"},"pool":{"min":0,"max":1},"useNullAsDefault":true}',
  'database',
  'sqlite3',
  'usi79om2c4s537dc',
  'wywlnmdv',
  0, 0, 0, 0, 0,
  5.0
);

-- Insert source pointing to that integration (matching exact nc_sources_v2 schema)
INSERT INTO nc_sources_v2 (id, base_id, alias, config, type, fk_workspace_id, fk_integration_id, enabled, "order", is_schema_readonly, is_data_readonly, is_local, inflection_column, inflection_table)
VALUES (
  'bpocketbase0001',
  'pjv1o7f7la64g0t',
  'pocketbase_db',
  '{"client":"sqlite3"}',
  'sqlite3',
  'wywlnmdv',
  'intpocketbase001',
  1,
  5.0,
  0, 0, 0,
  'camelize',
  'camelize'
);

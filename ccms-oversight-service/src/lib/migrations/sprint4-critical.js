export async function migrateSprint4Oversight(dataSource) {
  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock(43436, 407)');
    await manager.query('ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS entity_name varchar(300)');
    const [existing] = await manager.query("SELECT 1 FROM pg_constraint WHERE conname = 'audit_log_entity_name_ck' AND conrelid = 'audit_log'::regclass");
    if (!existing) await manager.query("ALTER TABLE audit_log ADD CONSTRAINT audit_log_entity_name_ck CHECK (entity_name IS NULL OR (char_length(btrim(entity_name)) BETWEEN 1 AND 300 AND entity_name !~ '[[:cntrl:]]'))");
    // Column addition changes no existing row values and preserves all table-level INSERT/SELECT-only grants.
  });
}

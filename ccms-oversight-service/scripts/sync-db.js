// Creates/updates this service's table, the two database roles and the grants (Sprint 4 TT2, CC005).
// It connects as the schema owner (DATABASE_ADMIN_URL). The running service connects as ccms_logs_writer
// (DATABASE_URL), which can only INSERT and SELECT on audit_log, so it never runs this.
import { getDataSource } from 'ccms-shared';
import { dbOptions } from '../src/lib/data-source.js';

const url = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
const dataSource = await getDataSource({ ...dbOptions, url, synchronize: true });
const tables = await dataSource.query(
  "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
);
console.log(`Database ready. Tables: ${tables.map((t) => t.table_name).join(', ') || '(none)'}`);
await dataSource.destroy();

import { createDataSource } from 'ccms-shared';
import { dbOptions } from '../src/lib/data-source.js';
import { migrateSprint4Oversight } from '../src/lib/migrations/sprint4-critical.js';
const ds = createDataSource({ ...dbOptions, url: process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL, synchronize: false });
await ds.initialize();
try { await migrateSprint4Oversight(ds); console.log('Sprint 4 Oversight migration completed'); }
finally { await ds.destroy(); }

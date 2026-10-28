import { migrateSprint4Oversight } from './migrations/sprint4-critical.js';
// Runs after TypeORM has created the table. Everything here is idempotent.
// TypeORM cannot declare descending indexes, CHECK constraints, roles or grants, so the Logs data rules live
// here (the team has no migrations yet, E22 open).

export const LOGS_WRITER_ROLE = 'ccms_logs_writer';
export const OVERSIGHT_APP_ROLE = 'ccms_oversight_app';

async function addConstraint(dataSource, table, name, definition) {
  const rows = await dataSource.query('SELECT 1 FROM pg_constraint WHERE conname = $1', [name]);
  if (!rows.length) await dataSource.query(`ALTER TABLE ${table} ADD CONSTRAINT ${name} ${definition}`);
}

async function sqlFor(dataSource, template, values) {
  const [{ sql }] = await dataSource.query(`SELECT format($format$${template}$format$, ${values.map((_, i) => `$${i + 1}::text`).join(', ')}) AS sql`, values);
  return sql;
}

/** Creates and hardens a runtime role, and gives it a password only when provisioning received one. */
async function ensureRole(dataSource, role, password) {
  const [existing] = await dataSource.query(
    'SELECT rolsuper, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1',
    [role],
  );
  if (!existing) {
    try {
      await dataSource.query(`CREATE ROLE ${role} NOLOGIN`);
    } catch (err) {
      // Another run created it a moment ago (duplicate_object): that is fine.
      if (err?.code !== '42710') throw err;
    }
  }

  // Managed PostgreSQL owners (including Neon owners) may have CREATEROLE without permission to change
  // SUPERUSER, REPLICATION, or BYPASSRLS. Fail closed if a pre-existing runtime role has any of those
  // capabilities; an infrastructure administrator must remove them before provisioning can safely continue.
  if (existing?.rolsuper || existing?.rolreplication || existing?.rolbypassrls) {
    throw new Error(`${role} has a prohibited administrative role attribute`);
  }
  await dataSource.query(`ALTER ROLE ${role} NOCREATEDB NOCREATEROLE NOINHERIT`);

  // NOINHERIT does not prevent SET ROLE. Remove every membership as well, including memberships added by
  // an earlier or accidental provisioning run.
  const memberships = await dataSource.query(
    `SELECT parent.rolname
       FROM pg_auth_members membership
       JOIN pg_roles member ON member.oid = membership.member
       JOIN pg_roles parent ON parent.oid = membership.roleid
      WHERE member.rolname = $1`,
    [role],
  );
  for (const membership of memberships) {
    await dataSource.query(await sqlFor(dataSource, 'REVOKE %I FROM %I', [membership.rolname, role]));
  }

  if (password) {
    // ALTER ROLE cannot take bind parameters, so the statement is built by the server with %I and %L quoting.
    await dataSource.query(await sqlFor(dataSource, 'ALTER ROLE %I WITH LOGIN PASSWORD %L', [role, password]));
  }
}

export async function afterSync(dataSource) {
  await migrateSprint4Oversight(dataSource);
  await auditLogRules(dataSource);

  // Keep all role mutations on one checked-out connection under an advisory lock so two syncs of this
  // database cannot concurrently update the same PostgreSQL system-catalog rows. The test suite runs its
  // temporary databases serially because PostgreSQL advisory locks do not span different databases while
  // roles do span the cluster.
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    await runner.query('SELECT pg_advisory_lock(43436, 2)');
    await auditLogGrants(runner);
  } finally {
    await runner.query('SELECT pg_advisory_unlock(43436, 2)').catch(() => {});
    await runner.release();
  }
}

async function auditLogRules(dataSource) {
  await dataSource.query('CREATE INDEX IF NOT EXISTS audit_log_occurred_idx ON audit_log (occurred_at DESC)');
  await dataSource.query('CREATE INDEX IF NOT EXISTS audit_log_office_occurred_idx ON audit_log (office_id, occurred_at DESC)');
  // A person is always named, except for events the system itself makes.
  await addConstraint(dataSource, 'audit_log', 'audit_log_actor_ck', "CHECK (actor_user_id IS NOT NULL OR actor_role = 'system')");
}

// Sprint 4 TT2 (D6, NFR-DAT-001): nobody can change or delete a past entry.
//   ccms_logs_writer    INSERT and SELECT on audit_log. The running service connects as this role.
//   ccms_oversight_app  SELECT only (the future reports and analytics).
// UPDATE, DELETE and TRUNCATE are refused for both and for everyone else (PUBLIC). The schema owner that runs
// `npm run db:sync` keeps the rights every table owner has; it is never the role the service runs as.
async function auditLogGrants(dataSource) {
  await ensureRole(dataSource, LOGS_WRITER_ROLE, process.env.LOGS_WRITER_PASSWORD);
  await ensureRole(dataSource, OVERSIGHT_APP_ROLE, process.env.OVERSIGHT_APP_PASSWORD);

  // PostgreSQL grants CONNECT and TEMPORARY on new databases to PUBLIC by default. Remove those defaults
  // so a credential from another CCMS database cannot enter this database even when both databases happen
  // to share a PostgreSQL cluster. The database owner retains its inherent migration rights.
  const database = (await dataSource.query('SELECT current_database() AS name'))[0].name;
  await dataSource.query(await sqlFor(dataSource, 'REVOKE ALL PRIVILEGES ON DATABASE %I FROM PUBLIC', [database]));

  // PUBLIC and the runtime roles start with no schema or object privileges. This also removes accidental
  // historical grants, including REFERENCES and TRIGGER, not only UPDATE/DELETE/TRUNCATE.
  await dataSource.query('REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC');
  await dataSource.query('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC');
  await dataSource.query('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC');
  await dataSource.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${LOGS_WRITER_ROLE}, ${OVERSIGHT_APP_ROLE}`);
  await dataSource.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${LOGS_WRITER_ROLE}, ${OVERSIGHT_APP_ROLE}`);

  // Future tables and sequences created by this migration owner also start private. A later migration must
  // explicitly grant the exact runtime access it needs.
  await dataSource.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC, ${LOGS_WRITER_ROLE}, ${OVERSIGHT_APP_ROLE}`);
  await dataSource.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC, ${LOGS_WRITER_ROLE}, ${OVERSIGHT_APP_ROLE}`);

  await dataSource.query(`GRANT INSERT, SELECT ON audit_log TO ${LOGS_WRITER_ROLE}`);
  await dataSource.query(`GRANT SELECT ON audit_log TO ${OVERSIGHT_APP_ROLE}`);

  await dataSource.query(
    await sqlFor(dataSource, 'GRANT CONNECT ON DATABASE %I TO %I, %I', [database, LOGS_WRITER_ROLE, OVERSIGHT_APP_ROLE]),
  );
  await dataSource.query(`GRANT USAGE ON SCHEMA public TO ${LOGS_WRITER_ROLE}, ${OVERSIGHT_APP_ROLE}`);
}

// Runs after TypeORM has created the table. Everything here is idempotent.
// TypeORM cannot declare descending indexes, CHECK constraints, roles or grants, so the Logs data rules live
// here (the team has no migrations yet, E22 open).

export const LOGS_WRITER_ROLE = 'ccms_logs_writer';
export const OVERSIGHT_APP_ROLE = 'ccms_oversight_app';

async function addConstraint(dataSource, table, name, definition) {
  const rows = await dataSource.query('SELECT 1 FROM pg_constraint WHERE conname = $1', [name]);
  if (!rows.length) await dataSource.query(`ALTER TABLE ${table} ADD CONSTRAINT ${name} ${definition}`);
}

/** Creates the role when it is missing and, when a password is given, lets it log in with that password. */
async function ensureRole(dataSource, role, password) {
  const existing = await dataSource.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  if (!existing.length) {
    try {
      await dataSource.query(`CREATE ROLE ${role} NOLOGIN`);
    } catch (err) {
      // Another run created it a moment ago (duplicate_object): that is fine.
      if (err?.code !== '42710') throw err;
    }
  }
  if (password) {
    // ALTER ROLE cannot take bind parameters, so the statement is built by the server with %I and %L quoting.
    const [{ sql }] = await dataSource.query("SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', $1::text, $2::text) AS sql", [
      role,
      password,
    ]);
    await dataSource.query(sql);
  }
}

export async function afterSync(dataSource) {
  await auditLogRules(dataSource);
  await auditLogGrants(dataSource);
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

  await dataSource.query('REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM PUBLIC');
  // Start from nothing for the two roles so a re-run also removes anything granted by mistake.
  await dataSource.query(`REVOKE ALL ON audit_log FROM ${LOGS_WRITER_ROLE}, ${OVERSIGHT_APP_ROLE}`);
  await dataSource.query(`GRANT INSERT, SELECT ON audit_log TO ${LOGS_WRITER_ROLE}`);
  await dataSource.query(`GRANT SELECT ON audit_log TO ${OVERSIGHT_APP_ROLE}`);

  const [{ sql }] = await dataSource.query(
    "SELECT format('GRANT CONNECT ON DATABASE %I TO %I, %I', current_database(), $1::text, $2::text) AS sql",
    [LOGS_WRITER_ROLE, OVERSIGHT_APP_ROLE],
  );
  await dataSource.query(sql);
  await dataSource.query(`GRANT USAGE ON SCHEMA public TO ${LOGS_WRITER_ROLE}, ${OVERSIGHT_APP_ROLE}`);
}

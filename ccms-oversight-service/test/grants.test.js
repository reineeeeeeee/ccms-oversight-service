import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { event, roleUrl, setupTestEnv } from './helpers.js';

async function queryAs(url, statement, params = []) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await client.query(statement, params);
  } finally {
    await client.end();
  }
}

async function transactionAs(url, statement, params = []) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');
    return await client.query(statement, params);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}

const denied = (url, statement, params = []) =>
  assert.rejects(transactionAs(url, statement, params), (err) => err.code === '42501');

describe('audit_log grants (TT2)', () => {
  let env;
  let auditId;
  let writerUrl;
  let readerUrl;
  let setOwnerRoleSql;

  before(async () => {
    env = await setupTestEnv();
    writerUrl = roleUrl(env.url, 'ccms_logs_writer');
    readerUrl = roleUrl(env.url, 'ccms_oversight_app');
    const [{ owner }] = await env.ds.query(
      'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = current_database()',
    );
    [{ sql: setOwnerRoleSql }] = await env.ds.query("SELECT format('SET ROLE %I', $1::text) AS sql", [owner]);
    const e = event();
    auditId = e.audit_id;
    await env.ds.query(
      `INSERT INTO audit_log (audit_id, actor_user_id, actor_role, action, entity_type, occurred_at) VALUES ($1, $2, 'super_admin', 'X', 'y', now())`,
      [auditId, e.actor_user_id],
    );
  });
  after(() => env.teardown());

  it('ccms_logs_writer authenticates directly and can INSERT and SELECT only', async () => {
    const select = await queryAs(writerUrl, 'SELECT audit_id FROM audit_log WHERE audit_id = $1', [auditId]);
    assert.equal(select.rows.length, 1);
    await transactionAs(
      writerUrl,
      `INSERT INTO audit_log (audit_id, actor_role, action, entity_type, occurred_at) VALUES (gen_random_uuid(), 'system', 'X', 'y', now())`,
    );
    for (const [statement, params] of [
      ['UPDATE audit_log SET action = $1', ['Z']],
      ['DELETE FROM audit_log WHERE action <> $1', ['Z']],
      ['TRUNCATE audit_log', []],
      ['ALTER TABLE audit_log ADD COLUMN forbidden text', []],
      ['CREATE TABLE public.forbidden(id int)', []],
      ['CREATE TEMP TABLE forbidden(id int)', []],
      [setOwnerRoleSql, []],
    ]) {
      await denied(writerUrl, statement, params);
    }
  });

  it('ccms_oversight_app authenticates directly and can SELECT only', async () => {
    assert.equal((await queryAs(readerUrl, 'SELECT count(*) FROM audit_log')).rows.length, 1);
    for (const [statement, params] of [
      [`INSERT INTO audit_log (audit_id, actor_role, action, entity_type, occurred_at) VALUES (gen_random_uuid(), 'system', 'X', 'y', now())`, []],
      ['UPDATE audit_log SET action = $1', ['Z']],
      ['DELETE FROM audit_log WHERE action <> $1', ['Z']],
      ['TRUNCATE audit_log', []],
      ['ALTER TABLE audit_log ADD COLUMN forbidden text', []],
      ['CREATE TABLE public.forbidden(id int)', []],
      ['CREATE TEMP TABLE forbidden(id int)', []],
      [setOwnerRoleSql, []],
    ]) {
      await denied(readerUrl, statement, params);
    }
  });

  it('removes administrative attributes, inherited memberships and all unnecessary grants', async () => {
    const roles = await env.ds.query(
      `SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
         FROM pg_roles WHERE rolname IN ('ccms_logs_writer', 'ccms_oversight_app') ORDER BY rolname`,
    );
    assert.equal(roles.length, 2);
    for (const role of roles) {
      for (const attribute of ['rolsuper', 'rolinherit', 'rolcreaterole', 'rolcreatedb', 'rolreplication', 'rolbypassrls']) {
        assert.equal(role[attribute], false, `${role.rolname} ${attribute}`);
      }
    }
    const memberships = await env.ds.query(
      `SELECT 1 FROM pg_auth_members membership JOIN pg_roles member ON member.oid = membership.member
        WHERE member.rolname IN ('ccms_logs_writer', 'ccms_oversight_app')`,
    );
    assert.equal(memberships.length, 0);

    for (const role of ['ccms_logs_writer', 'ccms_oversight_app']) {
      const [grants] = await env.ds.query(
        `SELECT has_database_privilege($1, current_database(), 'CONNECT') AS connect,
                has_database_privilege($1, current_database(), 'CREATE') AS database_create,
                has_database_privilege($1, current_database(), 'TEMP') AS temporary,
                has_schema_privilege($1, 'public', 'USAGE') AS schema_usage,
                has_schema_privilege($1, 'public', 'CREATE') AS schema_create,
                has_table_privilege($1, 'audit_log', 'UPDATE') AS update,
                has_table_privilege($1, 'audit_log', 'DELETE') AS delete,
                has_table_privilege($1, 'audit_log', 'TRUNCATE') AS truncate,
                has_table_privilege($1, 'audit_log', 'REFERENCES') AS references,
                has_table_privilege($1, 'audit_log', 'TRIGGER') AS trigger`,
        [role],
      );
      assert.deepEqual(grants, {
        connect: true,
        database_create: false,
        temporary: false,
        schema_usage: true,
        schema_create: false,
        update: false,
        delete: false,
        truncate: false,
        references: false,
        trigger: false,
      });
    }
  });

  it('does not let a runtime role grant itself UPDATE', async () => {
    await transactionAs(writerUrl, 'GRANT UPDATE ON audit_log TO ccms_logs_writer');
    const [{ allowed }] = await env.ds.query("SELECT has_table_privilege('ccms_logs_writer', 'audit_log', 'UPDATE') AS allowed");
    assert.equal(allowed, false);
  });

  it('refuses a separate Identity credential at the database boundary', async () => {
    const role = `ccms_identity_test_${randomBytes(5).toString('hex')}`;
    const password = randomBytes(18).toString('base64url');
    const [{ sql: createSql }] = await env.ds.query("SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) AS sql", [role, password]);
    const [{ sql: dropSql }] = await env.ds.query("SELECT format('DROP ROLE %I', $1::text) AS sql", [role]);
    await env.ds.query(createSql);
    try {
      await assert.rejects(queryAs(roleUrl(env.url, role, password), 'SELECT 1'), (err) => err.code === '42501');
    } finally {
      await env.ds.query(dropSql);
    }
  });

  it('keeps the protected row unchanged after every forbidden operation', async () => {
    const [row] = await env.ds.query('SELECT action FROM audit_log WHERE audit_id = $1', [auditId]);
    assert.deepEqual(row, { action: 'X' });
  });

  it('the CHECK refuses a row without a user unless the role is system', async () => {
    await assert.rejects(
      env.ds.query(`INSERT INTO audit_log (audit_id, actor_role, action, entity_type, occurred_at) VALUES (gen_random_uuid(), 'super_admin', 'X', 'y', now())`),
      (err) => err.code === '23514',
    );
  });
});

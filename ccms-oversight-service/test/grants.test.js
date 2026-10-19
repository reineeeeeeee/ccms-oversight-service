import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { event, setupTestEnv } from './helpers.js';

// TT2 / CC005 R1: the two application roles can never change or delete an audit row. The test connects as the
// database owner and switches into each role with SET ROLE, so no login password is needed.
async function asRole(url, role, statement, params = []) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    return await client.query(statement, params);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}

describe('audit_log grants (TT2)', () => {
  let env;
  let auditId;
  before(async () => {
    env = await setupTestEnv();
    const e = event();
    auditId = e.audit_id;
    await env.ds.query(
      `INSERT INTO audit_log (audit_id, actor_user_id, actor_role, action, entity_type, occurred_at) VALUES ($1, $2, 'super_admin', 'X', 'y', now())`,
      [auditId, e.actor_user_id],
    );
  });
  after(() => env.teardown());

  it('ccms_logs_writer can INSERT and SELECT but not UPDATE, DELETE or TRUNCATE', async () => {
    const select = await asRole(env.url, 'ccms_logs_writer', 'SELECT audit_id FROM audit_log WHERE audit_id = $1', [auditId]);
    assert.equal(select.rows.length, 1);
    await asRole(
      env.url,
      'ccms_logs_writer',
      `INSERT INTO audit_log (audit_id, actor_role, action, entity_type, occurred_at) VALUES (gen_random_uuid(), 'system', 'X', 'y', now())`,
    );
    for (const statement of ['UPDATE audit_log SET action = $1', 'DELETE FROM audit_log WHERE action <> $1', 'TRUNCATE audit_log']) {
      await assert.rejects(asRole(env.url, 'ccms_logs_writer', statement, statement.includes('$1') ? ['Z'] : []), (err) => err.code === '42501');
    }
  });

  it('ccms_oversight_app can only SELECT', async () => {
    assert.equal((await asRole(env.url, 'ccms_oversight_app', 'SELECT count(*) FROM audit_log')).rows.length, 1);
    await assert.rejects(
      asRole(env.url, 'ccms_oversight_app', `INSERT INTO audit_log (audit_id, actor_role, action, entity_type, occurred_at) VALUES (gen_random_uuid(), 'system', 'X', 'y', now())`),
      (err) => err.code === '42501',
    );
    for (const statement of ['UPDATE audit_log SET action = $1', 'DELETE FROM audit_log WHERE action <> $1', 'TRUNCATE audit_log']) {
      await assert.rejects(asRole(env.url, 'ccms_oversight_app', statement, statement.includes('$1') ? ['Z'] : []), (err) => err.code === '42501');
    }
  });

  it('the CHECK refuses a row without a user unless the role is system', async () => {
    await assert.rejects(
      env.ds.query(`INSERT INTO audit_log (audit_id, actor_role, action, entity_type, occurred_at) VALUES (gen_random_uuid(), 'super_admin', 'X', 'y', now())`),
      (err) => err.code === '23514',
    );
  });
});

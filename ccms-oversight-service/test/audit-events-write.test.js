import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { POST } from '../src/app/api/audit-events/route.js';
import { SERVICE_KEY, call, event, req, setupTestEnv } from './helpers.js';

const post = (body, options = {}) => call(POST, req('POST', '/audit-events', { body, key: SERVICE_KEY, ...options }));

describe('POST /audit-events (CC005)', () => {
  let env;
  before(async () => {
    env = await setupTestEnv();
  });
  after(() => env.teardown());

  it('stores a valid event once: 201 stored true, then 200 stored false with the first version kept', async () => {
    const e = event();
    const first = await post(e);
    assert.equal(first.status, 201);
    assert.deepEqual(first.body, { audit_id: e.audit_id, stored: true });
    const again = await post({ ...e, action: 'CHANGED_AFTERWARDS' });
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, { audit_id: e.audit_id, stored: false });
    const rows = await env.ds.query('SELECT action, after_value, occurred_at, received_at FROM audit_log WHERE audit_id = $1', [e.audit_id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'OFFICE_CREATED');
    assert.deepEqual(rows[0].after_value, { office_code: 'PUP-OSAS' });
    assert.equal(new Date(rows[0].occurred_at).toISOString(), '2026-10-06T02:00:00.000Z');
    assert.ok(rows[0].received_at);
  });

  it('accepts a system event without a user, campus-level (no office) and an entity id that is not a UUID', async () => {
    const e = event({ actor_user_id: null, actor_role: 'system', office_id: null, entity_id: 'campus' });
    assert.equal((await post(e)).status, 201);
  });

  it('needs the service key: 401 with none, a wrong one, or only a user token', async () => {
    const e = event();
    assert.equal((await call(POST, req('POST', '/audit-events', { body: e }))).status, 401);
    assert.equal((await call(POST, req('POST', '/audit-events', { body: e, key: 'wrong' }))).status, 401);
    assert.equal((await call(POST, req('POST', '/audit-events', { body: e, token: env.tokens.superAdmin }))).status, 401);
    const rows = await env.ds.query('SELECT 1 FROM audit_log WHERE audit_id = $1', [e.audit_id]);
    assert.equal(rows.length, 0);
  });

  it('rejects an invalid event with 400 and field details, and stores nothing', async () => {
    const bad = {
      audit_id: 'not-a-uuid',
      actor_role: 'janitor',
      action: '',
      entity_type: 'x'.repeat(61),
      entity_id: 'y'.repeat(101),
      office_id: 'nope',
      before_value: [],
      after_value: 'text',
      occurred_at: '2026-10-06 10:00',
    };
    const res = await post(bad);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    for (const field of ['audit_id', 'actor_role', 'actor_user_id', 'action', 'entity_type', 'entity_id', 'office_id', 'before_value', 'after_value', 'occurred_at']) {
      assert.ok(res.body.error.details[field], `${field} should be reported`);
    }
    const [{ count }] = await env.ds.query('SELECT count(*)::int AS count FROM audit_log WHERE entity_type = $1', ['x'.repeat(61)]);
    assert.equal(count, 0);
  });

  it('requires a user id unless the role is system, and a time zone offset on occurred_at', async () => {
    const noUser = await post(event({ actor_user_id: null }));
    assert.equal(noUser.status, 400);
    assert.ok(noUser.body.error.details.actor_user_id);
    const noOffset = await post(event({ occurred_at: '2026-10-06T10:00:00' }));
    assert.equal(noOffset.status, 400);
    assert.ok(noOffset.body.error.details.occurred_at);
  });

  it('answers 400 for malformed JSON and for a body that is not an object', async () => {
    const malformed = await call(POST, req('POST', '/audit-events', { raw: '{"audit_id":', key: SERVICE_KEY }));
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, 'INVALID_JSON');
    const array = await call(POST, req('POST', '/audit-events', { raw: '[]', key: SERVICE_KEY }));
    assert.equal(array.status, 400);
  });

  it('answers 413 when the body is over 256 KB', async () => {
    const big = event({ after_value: { text: 'x'.repeat(300 * 1024) } });
    const res = await post(big);
    assert.equal(res.status, 413);
    assert.equal(res.body.error.code, 'PAYLOAD_TOO_LARGE');
    const rows = await env.ds.query('SELECT 1 FROM audit_log WHERE audit_id = $1', [big.audit_id]);
    assert.equal(rows.length, 0);
  });

  it('keeps the old occurred_at for a backlog event and ignores unknown fields', async () => {
    const e = event({ audit_id: randomUUID(), occurred_at: '2026-01-05T08:00:00+08:00', extra_field: 'ignored' });
    assert.equal((await post(e)).status, 201);
    const [row] = await env.ds.query('SELECT occurred_at FROM audit_log WHERE audit_id = $1', [e.audit_id]);
    assert.equal(new Date(row.occurred_at).toISOString(), '2026-01-05T00:00:00.000Z');
  });
});

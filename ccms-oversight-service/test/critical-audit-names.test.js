import { strict as assert } from 'node:assert';
import { before, after, describe, it } from 'node:test';
import { setupTestEnv, call, req, event, tokens, SERVICE_KEY } from './helpers.js';
import { POST, GET } from '../src/app/api/audit-events/route.js';
import { migrateSprint4Oversight } from '../src/lib/migrations/sprint4-critical.js';
let env;
before(async () => { env = await setupTestEnv(); });
after(async () => { await env?.teardown(); });
describe('F7 audit label storage and append-only compatibility', () => {
  it('stores and returns names without altering event identity or old rows', async () => {
    const old = event();
    assert.equal((await call(POST, req('POST', '/audit-events', { key: SERVICE_KEY, body: old }))).status, 201);
    const current = event({ entity_name: 'Student Affairs' });
    await call(POST, req('POST', '/audit-events', { key: SERVICE_KEY, body: current }));
    const list = await call(GET, req('GET', '/audit-events', { token: tokens.superAdmin }));
    assert.equal(list.body.items.find((r) => r.audit_id === old.audit_id).entity_name, null);
    assert.equal(list.body.items.find((r) => r.audit_id === current.audit_id).entity_name, 'Student Affairs');
    await call(POST, req('POST', '/audit-events', { key: SERVICE_KEY, body: { ...current, entity_name: 'Changed' } }));
    assert.equal((await env.ds.query('SELECT entity_name FROM audit_log WHERE audit_id=$1', [current.audit_id]))[0].entity_name, 'Student Affairs');
    await migrateSprint4Oversight(env.ds); await migrateSprint4Oversight(env.ds);
    assert.equal((await env.ds.query('SELECT entity_name FROM audit_log WHERE audit_id=$1', [old.audit_id]))[0].entity_name, null);
  });
  it('rejects citizen names/contact fields as labels and malformed or oversized labels', async () => {
    for (const over of [
      { entity_type: 'transaction', entity_name: 'Citizen Test Person' },
      { entity_type: 'student', entity_name: 'Citizen Test Person' },
      { entity_type: 'office', entity_name: 'citizen@example.test' },
      { entity_type: 'office', entity_name: 'A'.repeat(301) },
      { entity_type: 'office', entity_name: 'Line\nbreak' },
    ]) {
      const result = await call(POST, req('POST', '/audit-events', { key: SERVICE_KEY, body: event(over) }));
      assert.equal(result.status, 400); assert.ok(result.body.error.details.entity_name);
    }
    assert.equal((await call(POST, req('POST', '/audit-events', { key: SERVICE_KEY, body: event({ entity_type: 'transaction', entity_name: 'PUP-OSAS-20261110-0001' }) }))).status, 201);
  });
});

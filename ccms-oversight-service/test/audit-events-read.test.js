import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GET, POST } from '../src/app/api/audit-events/route.js';
import { OFFICE_A, OFFICE_B, SERVICE_KEY, USERS, call, event, req, setupTestEnv } from './helpers.js';

const get = (path, token) => call(GET, req('GET', `/audit-events${path}`, { token }));

describe('GET /audit-events (CC019, CC020)', () => {
  let env;
  const ids = {};
  before(async () => {
    env = await setupTestEnv();
    const seed = [
      ['a1', { office_id: OFFICE_A, action: 'OFFICE_CREATED', occurred_at: '2026-10-01T01:00:00Z' }],
      ['a2', { office_id: OFFICE_A, action: 'SERVICE_UPDATED', entity_type: 'service', occurred_at: '2026-10-02T01:00:00Z' }],
      ['b1', { office_id: OFFICE_B, action: 'OFFICE_CREATED', occurred_at: '2026-10-03T01:00:00Z' }],
      ['campus', { office_id: null, action: 'CALENDAR_ENTRY_CREATED', entity_type: 'calendar_exception', occurred_at: '2026-10-04T01:00:00Z' }],
      ['staff', { office_id: OFFICE_A, actor_user_id: USERS.staffA, actor_role: 'office_staff', action: 'TRANSACTION_STARTED', entity_type: 'transaction', occurred_at: '2026-10-05T01:00:00Z' }],
    ];
    for (const [name, overrides] of seed) {
      const e = event(overrides);
      ids[name] = e.audit_id;
      const res = await call(POST, req('POST', '/audit-events', { body: e, key: SERVICE_KEY }));
      assert.equal(res.status, 201);
    }
  });
  after(() => env.teardown());

  it('Super Admin sees every entry, newest first, in the list shape of GET /services', async () => {
    const res = await get('', env.tokens.superAdmin);
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 5);
    assert.equal(res.body.page, 1);
    assert.equal(res.body.page_size, 20);
    assert.deepEqual(res.body.items.map((i) => i.audit_id), [ids.staff, ids.campus, ids.b1, ids.a2, ids.a1]);
    assert.deepEqual(Object.keys(res.body.items[0]).sort(), [
      'action', 'actor_role', 'actor_user_id', 'after_value', 'audit_id', 'before_value', 'entity_id', 'entity_type', 'ip_address', 'occurred_at', 'office_id',
    ]);
    assert.equal(res.body.items[4].occurred_at, '2026-10-01T01:00:00.000Z');
  });

  it('combines filters with AND and matches action, entity_type and actor exactly', async () => {
    assert.equal((await get('?action=OFFICE_CREATED', env.tokens.superAdmin)).body.total, 2);
    assert.equal((await get('?action=OFFICE', env.tokens.superAdmin)).body.total, 0);
    assert.equal((await get('?entity_type=service', env.tokens.superAdmin)).body.total, 1);
    assert.equal((await get(`?actor=${USERS.staffA}`, env.tokens.superAdmin)).body.total, 1);
    assert.equal((await get(`?action=OFFICE_CREATED&office_id=${OFFICE_B}`, env.tokens.superAdmin)).body.total, 1);
  });

  it('filters by Manila calendar dates, inclusive: Oct 2 in Manila starts at 16:00 UTC on Oct 1', async () => {
    // a1 = Oct 1 09:00 Manila, a2 = Oct 2 09:00 Manila, b1 = Oct 3 09:00 Manila
    const one = await get('?from=2026-10-02&to=2026-10-02', env.tokens.superAdmin);
    assert.deepEqual(one.body.items.map((i) => i.audit_id), [ids.a2]);
    const range = await get('?from=2026-10-02&to=2026-10-03', env.tokens.superAdmin);
    assert.deepEqual(range.body.items.map((i) => i.audit_id), [ids.b1, ids.a2]);
  });

  it('paginates', async () => {
    const res = await get('?page=2&page_size=2', env.tokens.superAdmin);
    assert.equal(res.body.total, 5);
    assert.equal(res.body.page, 2);
    assert.equal(res.body.page_size, 2);
    assert.deepEqual(res.body.items.map((i) => i.audit_id), [ids.b1, ids.a2]);
  });

  it('rejects bad filters with 400 and field details', async () => {
    const res = await get(`?actor=x&from=2026-10-05&to=2026-10-01&page=0&page_size=500&office_id=y&action=${'a'.repeat(81)}`, env.tokens.superAdmin);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    const reversed = await get('?from=2026-10-05&to=2026-10-01', env.tokens.superAdmin);
    assert.equal(reversed.status, 400);
    assert.equal(reversed.body.error.details.from, 'From date must be on or before To date');
    assert.ok((await get('?page=0', env.tokens.superAdmin)).body.error.details.page);
  });

  it('Office Head sees only their own office; campus-level and other offices never reach them', async () => {
    const res = await get('', env.tokens.officeHeadA);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items.map((i) => i.audit_id), [ids.staff, ids.a2, ids.a1]);
    assert.equal(res.body.total, 3);
    const own = await get(`?office_id=${OFFICE_A}`, env.tokens.officeHeadA);
    assert.equal(own.status, 200);
    assert.equal(own.body.total, 3);
    const otherOffice = await get(`?office_id=${OFFICE_B}`, env.tokens.officeHeadA);
    assert.equal(otherOffice.status, 403);
    assert.equal(otherOffice.body.error.code, 'FORBIDDEN');
    assert.equal((await get('', env.tokens.officeHeadB)).body.total, 1);
  });

  it('Office Staff and Executive get 403; no token gets 401', async () => {
    assert.equal((await get('', env.tokens.officeStaffA)).status, 403);
    assert.equal((await get('', env.tokens.executive)).status, 403);
    assert.equal((await get('')).status, 401);
  });

  it('has no route to edit or delete an entry', async () => {
    const route = await import('../src/app/api/audit-events/route.js');
    for (const method of ['PUT', 'PATCH', 'DELETE']) assert.equal(route[method], undefined);
  });
});

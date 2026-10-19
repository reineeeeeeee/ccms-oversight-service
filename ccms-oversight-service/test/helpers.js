// Shared test setup (not a test file): a database with the roles and grants, tokens and request helpers.
import { randomUUID } from 'node:crypto';
import { ROLES, setDataSource, setDefaultVerifier } from 'ccms-shared';
import { createTestDatabase, createTestKeys } from 'ccms-shared/testing';
import { afterSync } from '../src/lib/after-sync.js';
import { entities } from '../src/lib/entities/index.js';

export const SERVICE_KEY = 'test-service-key-0123456789';
export const OFFICE_A = randomUUID();
export const OFFICE_B = randomUUID();
export const USERS = { adminId: randomUUID(), headA: randomUUID(), staffA: randomUUID(), headB: randomUUID(), execId: randomUUID() };

export const tokens = {};

export async function setupTestEnv() {
  process.env.SERVICE_KEY = SERVICE_KEY;
  const keys = await createTestKeys();
  setDefaultVerifier(keys.verifier);
  const testDb = await createTestDatabase({ entities, afterSync });
  setDataSource(testDb.dataSource);
  Object.assign(tokens, {
    superAdmin: await keys.signToken({ sub: USERS.adminId, role: ROLES.SUPER_ADMIN, full_name: 'Sam Admin' }),
    executive: await keys.signToken({ sub: USERS.execId, role: ROLES.EXECUTIVE }),
    officeHeadA: await keys.signToken({ sub: USERS.headA, role: ROLES.OFFICE_HEAD, office_id: OFFICE_A }),
    officeStaffA: await keys.signToken({ sub: USERS.staffA, role: ROLES.OFFICE_STAFF, office_id: OFFICE_A }),
    officeHeadB: await keys.signToken({ sub: USERS.headB, role: ROLES.OFFICE_HEAD, office_id: OFFICE_B }),
  });
  return {
    ds: testDb.dataSource,
    url: testDb.url,
    tokens,
    async teardown() {
      setDataSource(null);
      await testDb.drop();
    },
  };
}

export const req = (method, path, { token, body, headers, key, raw } = {}) =>
  new Request(`http://localhost/api${path}`, {
    method,
    headers: {
      ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'x-service-key': key } : {}),
      ...headers,
    },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });

/** Calls a route handler and returns { status, body, headers }. */
export async function call(handler, request, context) {
  const response = await handler(request, context);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}

/** A valid audit event as recordAudit (ccms-shared) sends it. */
export function event(overrides = {}) {
  return {
    audit_id: randomUUID(),
    actor_user_id: USERS.adminId,
    actor_role: 'super_admin',
    action: 'OFFICE_CREATED',
    entity_type: 'office',
    entity_id: randomUUID(),
    office_id: OFFICE_A,
    before_value: null,
    after_value: { office_code: 'PUP-OSAS' },
    ip_address: '203.0.113.5',
    occurred_at: '2026-10-06T02:00:00.000Z',
    ...overrides,
  };
}

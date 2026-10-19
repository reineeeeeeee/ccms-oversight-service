import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GET } from '../src/app/api/health/route.js';
import { call, req, setupTestEnv } from './helpers.js';

describe('GET /health (TT2)', () => {
  let env;
  before(async () => {
    env = await setupTestEnv();
  });
  after(() => env.teardown());

  it('answers UP without a token', async () => {
    const res = await call(GET, req('GET', '/health'));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: 'UP' });
  });
});

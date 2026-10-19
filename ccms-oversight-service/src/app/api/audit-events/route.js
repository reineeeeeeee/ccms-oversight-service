import { ROLES, json, requirePermission, requireServiceKey, route } from 'ccms-shared';
import { getDb } from '../../../lib/data-source.js';
import { listAuditEvents, readAuditBody, storeAuditEvent, validateAuditEvent } from '../../../modules/logs/index.js';

export const dynamic = 'force-dynamic';

// Only the Super Admin and Office Heads read the logs; Office Staff and Executive get 403. Office Heads see their own office only.
const canRead = requirePermission([ROLES.SUPER_ADMIN, ROLES.OFFICE_HEAD], 'campus');

// POST /audit-events — one audit event from another CCMS service (CC005). Service key only: no user token is accepted,
// and the gateway never forwards a browser's POST to this path. 201 { audit_id, stored: true } when stored,
// 200 { audit_id, stored: false } when that audit_id was stored before. Not audited (this is the audit store).
export const POST = route(async (request) => {
  requireServiceKey(request);
  const event = validateAuditEvent(await readAuditBody(request));
  const result = await storeAuditEvent(await getDb(), event);
  return json(result, result.stored ? 201 : 200);
});

// GET /audit-events?actor=&action=&entity_type=&office_id=&from=&to=&page=&page_size= — read-only list (CC019, CC020).
export const GET = route(async (request) => {
  const user = await canRead(request);
  return json(await listAuditEvents(await getDb(), user, new URL(request.url).searchParams));
});

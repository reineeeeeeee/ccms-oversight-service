import { Buffer } from 'node:buffer';
import { AppError, Errors, ROLES, isUuid } from 'ccms-shared';

// Sprint 4 CC005: the receiver for audit events. One service sends each event with recordAudit (ccms-shared); this
// module checks the body, stores it once (ON CONFLICT DO NOTHING on audit_id) and never changes it afterwards.

export const ACTOR_ROLES = [ROLES.SUPER_ADMIN, ROLES.OFFICE_HEAD, ROLES.OFFICE_STAFF, ROLES.EXECUTIVE, 'system'];
export const MAX_BODY_BYTES = 256 * 1024; // PROPOSED limit (validation rules, CC005)

// An ISO-8601 instant must carry its own offset, so the value never depends on the server's time zone.
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

const tooLarge = () => new AppError(413, 'PAYLOAD_TOO_LARGE', `The request body must be ${MAX_BODY_BYTES / 1024} KB or smaller`);

/** The JSON object of the request body, at most 256 KB. Malformed JSON is a 400 and nothing is stored. */
export async function readAuditBody(request) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw tooLarge();
  const text = await request.text().catch(() => '');
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw tooLarge();
  if (!text.trim()) throw Errors.validation('Request body is required');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw Errors.badRequest('Request body must be a valid JSON object', null, 'INVALID_JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw Errors.badRequest('Request body must be a valid JSON object', null, 'INVALID_JSON');
  }
  return value;
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Checks every field and collects all problems by field name (400 VALIDATION_ERROR with details). Values are kept
 * exactly as received. Returns the event ready to insert.
 */
export function validateAuditEvent(body) {
  const details = {};
  const requiredText = (field, max) => {
    const value = body[field];
    if (typeof value !== 'string' || !value.trim()) details[field] = `${field} is required`;
    else if (value.length > max) details[field] = `${field} must be ${max} characters or fewer`;
    return value;
  };

  const auditId = body.audit_id;
  if (!isUuid(auditId)) details.audit_id = 'audit_id must be a valid ID';

  const actorRole = body.actor_role;
  if (!ACTOR_ROLES.includes(actorRole)) details.actor_role = `actor_role must be one of ${ACTOR_ROLES.join(', ')}`;

  const actorUserId = body.actor_user_id ?? null;
  if (actorUserId === null) {
    if (actorRole !== 'system') details.actor_user_id = 'actor_user_id is required unless actor_role is system';
  } else if (!isUuid(actorUserId)) {
    details.actor_user_id = 'actor_user_id must be a valid ID';
  }

  const action = requiredText('action', 80);
  const entityType = requiredText('entity_type', 60);

  let entityId = body.entity_id ?? null;
  if (entityId !== null && (typeof entityId !== 'string' || entityId.length > 100)) {
    details.entity_id = typeof entityId === 'string' ? 'entity_id must be 100 characters or fewer' : 'entity_id must be text';
    entityId = null;
  }

  const officeId = body.office_id ?? null;
  if (officeId !== null && !isUuid(officeId)) details.office_id = 'office_id must be a valid ID';

  const values = {};
  for (const field of ['before_value', 'after_value']) {
    const value = body[field] ?? null;
    if (value !== null && !isPlainObject(value)) details[field] = `${field} must be a JSON object or null`;
    values[field] = value;
  }

  const ipAddress = body.ip_address ?? null;
  if (ipAddress !== null && (typeof ipAddress !== 'string' || ipAddress.length > 64)) {
    details.ip_address = 'ip_address must be text of 64 characters or fewer';
  }

  let occurredAt = null;
  const occurredText = typeof body.occurred_at === 'string' ? body.occurred_at.trim() : '';
  const occurredMs = ISO_WITH_OFFSET.test(occurredText) ? Date.parse(occurredText) : Number.NaN;
  if (Number.isFinite(occurredMs)) occurredAt = new Date(occurredMs);
  else details.occurred_at = 'occurred_at must be an ISO timestamp with a time zone offset, for example 2026-10-06T10:00:00Z';

  if (Object.keys(details).length) throw Errors.validation('Please correct the highlighted fields', details);
  return {
    auditId,
    actorUserId,
    actorRole,
    action,
    entityType,
    entityId,
    officeId,
    beforeValue: values.before_value,
    afterValue: values.after_value,
    ipAddress,
    occurredAt,
  };
}

const jsonOrNull = (value) => (value === null ? null : JSON.stringify(value));

/**
 * Stores one event. The first stored version wins: an event with an audit_id that already exists changes nothing
 * and answers stored:false (R2). Returns { audit_id, stored }.
 */
export async function storeAuditEvent(dataSource, event) {
  const result = await dataSource.query(
    `INSERT INTO audit_log
       (audit_id, actor_user_id, actor_role, action, entity_type, entity_id, office_id, before_value, after_value, ip_address, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)
     ON CONFLICT (audit_id) DO NOTHING
     RETURNING audit_id`,
    [
      event.auditId,
      event.actorUserId,
      event.actorRole,
      event.action,
      event.entityType,
      event.entityId,
      event.officeId,
      jsonOrNull(event.beforeValue),
      jsonOrNull(event.afterValue),
      event.ipAddress,
      event.occurredAt,
    ],
  );
  const rows = Array.isArray(result?.[0]) ? result[0] : (result ?? []);
  return { audit_id: event.auditId, stored: rows.length > 0 };
}

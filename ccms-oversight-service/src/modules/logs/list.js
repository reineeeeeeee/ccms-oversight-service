import { Errors, ROLES, endOfManilaDay, fromManila, isUuid, isValidManilaDate } from 'ccms-shared';

/** page / page_size from query parameters (defaults 1 / 20, size at most 100): the same limits and shape as GET /services. */
export function parsePaging(params, { defaultSize = 20, maxSize = 100 } = {}) {
  const details = {};
  const read = (name, fallback, max) => {
    const raw = params.get(name);
    if (raw === null || raw === '') return fallback;
    const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isInteger(n) || n < 1 || n > max) {
      details[name] = `${name} must be a whole number from 1 to ${max}`;
      return fallback;
    }
    return n;
  };
  const page = read('page', 1, 1_000_000);
  const pageSize = read('page_size', defaultSize, maxSize);
  if (Object.keys(details).length) throw Errors.validation('Please correct the highlighted fields', details);
  return { page, pageSize };
}

export function toAuditEventDto(row) {
  return {
    audit_id: row.audit_id,
    actor_user_id: row.actor_user_id,
    actor_role: row.actor_role,
    action: row.action,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    entity_name: row.entity_name ?? null,
    office_id: row.office_id,
    before_value: row.before_value,
    after_value: row.after_value,
    ip_address: row.ip_address,
    occurred_at: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
  };
}

const SELECT_COLUMNS =
  'audit_id, actor_user_id, actor_role, action, entity_type, entity_id, entity_name, office_id, before_value, after_value, ip_address, occurred_at';

/**
 * GET /audit-events?actor=&action=&entity_type=&office_id=&from=&to=&page=&page_size=
 * Scope (CC019, CC020), enforced here and not by hiding menu items:
 *   Super Admin    every entry, including the campus-level ones (no office); office_id narrows it
 *   Office Head    only the office in the token; another office_id is a 403; entries with no office never reach them
 *   anyone else    403
 * Filters combine with AND; actor, action and entity_type are exact matches. Dates are Manila calendar dates
 * (`from` 00:00:00 to `to` 23:59:59). Newest first (occurred_at DESC, then audit_id). Read-only and not audited.
 */
export async function listAuditEvents(dataSource, user, params) {
  if (user.role !== ROLES.SUPER_ADMIN && user.role !== ROLES.OFFICE_HEAD) throw Errors.forbidden();
  const { page, pageSize } = parsePaging(params);

  const details = {};
  const actor = params.get('actor');
  const action = params.get('action');
  const entityType = params.get('entity_type');
  const officeId = params.get('office_id');
  const from = params.get('from');
  const to = params.get('to');
  if (actor && !isUuid(actor)) details.actor = 'actor must be a valid ID';
  if (action && action.length > 80) details.action = 'action must be 80 characters or fewer';
  if (entityType && entityType.length > 80) details.entity_type = 'entity_type must be 80 characters or fewer';
  if (officeId && !isUuid(officeId)) details.office_id = 'office_id must be a valid ID';
  if (from && !isValidManilaDate(from)) details.from = 'From must be a date (YYYY-MM-DD)';
  if (to && !isValidManilaDate(to)) details.to = 'To must be a date (YYYY-MM-DD)';
  if (!details.from && !details.to && from && to && from > to) details.from = 'From date must be on or before To date';
  if (Object.keys(details).length) throw Errors.validation('Please correct the highlighted fields', details);

  const where = [];
  const values = [];
  const add = (sql, value) => {
    values.push(value);
    where.push(sql.replaceAll('?', `$${values.length}`));
  };

  if (user.role === ROLES.OFFICE_HEAD) {
    if (!user.officeId || (officeId && officeId.toLowerCase() !== String(user.officeId).toLowerCase())) throw Errors.forbidden();
    add('office_id = ?::uuid', user.officeId);
  } else if (officeId) {
    add('office_id = ?::uuid', officeId);
  }
  if (actor) add('actor_user_id = ?::uuid', actor);
  if (action) add('action = ?', action);
  if (entityType) add('entity_type = ?', entityType);
  if (from) add('occurred_at >= ?', fromManila(from));
  if (to) add('occurred_at <= ?', endOfManilaDay(fromManila(to)));
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';

  const [{ total }] = await dataSource.query(`SELECT count(*)::int AS total FROM audit_log${whereSql}`, values);
  values.push(pageSize, (page - 1) * pageSize);
  const rows = await dataSource.query(
    `SELECT ${SELECT_COLUMNS} FROM audit_log${whereSql} ORDER BY occurred_at DESC, audit_id ASC LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  return { items: rows.map(toAuditEventDto), page, page_size: pageSize, total };
}

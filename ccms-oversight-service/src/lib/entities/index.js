import { EntitySchema } from 'typeorm';

// ---- Logs (ERD section 8, with the Sprint 4 approvals of 10/18, Decision G15) ----

// One audit entry, written once and never changed (D6): UPDATE, DELETE and TRUNCATE are not granted to any
// application role (src/lib/after-sync.js). audit_id is the id the sending service made, so a re-sent event is
// recognised and ignored. There are no foreign keys: user and office are plain IDs owned by other services.
// entity_id is text (UUIDs and "campus" are both valid) and actor_role also allows "system".
// The (occurred_at DESC) and (office_id, occurred_at DESC) indexes and the actor CHECK are created in after-sync.
export const AuditLog = new EntitySchema({
  name: 'AuditLog',
  tableName: 'audit_log',
  columns: {
    auditId: { name: 'audit_id', type: 'uuid', primary: true },
    actorUserId: { name: 'actor_user_id', type: 'uuid', nullable: true },
    actorRole: { name: 'actor_role', type: 'varchar', length: 30 },
    action: { type: 'varchar', length: 80 },
    entityType: { name: 'entity_type', type: 'varchar', length: 60 },
    entityId: { name: 'entity_id', type: 'varchar', length: 100, nullable: true },
    officeId: { name: 'office_id', type: 'uuid', nullable: true },
    beforeValue: { name: 'before_value', type: 'jsonb', nullable: true },
    afterValue: { name: 'after_value', type: 'jsonb', nullable: true },
    ipAddress: { name: 'ip_address', type: 'varchar', length: 64, nullable: true },
    occurredAt: { name: 'occurred_at', type: 'timestamptz' },
    receivedAt: { name: 'received_at', type: 'timestamptz', default: () => 'now()' },
  },
  indices: [
    { name: 'audit_log_action_idx', columns: ['action'] },
    { name: 'audit_log_entity_type_idx', columns: ['entityType'] },
    { name: 'audit_log_actor_idx', columns: ['actorUserId'] },
  ],
});

// The Logs module only receives and shows entries: it has no outbox and sends nothing out (BR-LOG-001).
export const entities = [AuditLog];

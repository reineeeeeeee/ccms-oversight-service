# ccms-oversight-service (Logs)

Part of the Citizen's Charter Compliance/Monitoring System (CCMS). One service = one repository = one database (`ccms_oversight`).
This service keeps the **audit trail**: it receives audit events from the other services, stores them once and never changes them,
and lets the Super Admin (all entries) and Office Heads (their own office) read them. **API only**: the Logs screens live in
`ccms-frontend`; the browser reaches this service through `ccms-api-gateway` (`/api/logs/*` arrives here as `/api/*`).
Only the `logs` module exists now (Sprint 4: TT2, CC005, CC019, CC020); reports and analytics come in Sprints 5-6.

Stack: Next.js Route Handlers (JavaScript) · TypeORM · PostgreSQL 15+ · `ccms-shared` (vendored). Same layout as `ccms-core-service`.

```
src/app/api/        routes (health, audit-events)
src/modules/logs/   audit-events (validate + store), list (the viewer query)
src/lib/            data-source, entities (AuditLog), after-sync (indexes, CHECK, roles, grants)
test/               node:test (needs PostgreSQL: TEST_PG_URL)
```

## Run

```bash
# 1. a PostgreSQL database named ccms_oversight whose owner is ccms_oversight
docker run -d --name ccms-oversight-db -e POSTGRES_USER=ccms_oversight -e POSTGRES_PASSWORD=ccms_oversight_dev_pw \
  -e POSTGRES_DB=ccms_oversight -p 5437:5432 -v ccms_oversight_data:/var/lib/postgresql/data postgres:16

cp .env.example .env.local
npm install
npm run db:sync      # creates audit_log, the two roles and the grants (connects as the owner)
npm run dev          # http://127.0.0.1:3002/api/health  ->  { "status": "UP" }
```

## Database roles (TT2, D6)

`npm run db:sync` connects as the schema owner (`DATABASE_ADMIN_URL`) and, in `src/lib/after-sync.js`:

| Role | Rights on `audit_log` | Used by |
| --- | --- | --- |
| `ccms_logs_writer` | INSERT, SELECT | this service when it runs (`DATABASE_URL`) |
| `ccms_oversight_app` | SELECT | the future reports and analytics |
| everyone else (PUBLIC) | no UPDATE, DELETE or TRUNCATE | |

The running service uses `ccms_logs_writer` and `DB_SYNCHRONIZE=false`, so no application role can change or delete a past entry.
The schema owner keeps the rights every table owner has and must never be the role the service runs as. On Neon, create the
database and the owner role in the console first; `db:sync` creates the two roles and sets their passwords from
`LOGS_WRITER_PASSWORD` and `OVERSIGHT_APP_PASSWORD`.

## API (under `/api`)

| Route | Who |
| --- | --- |
| `GET /health` | anyone (503 when the database is unreachable) |
| `POST /audit-events` | **service key only** (`x-service-key`); the gateway never forwards a browser POST here |
| `GET /audit-events?actor=&action=&entity_type=&office_id=&from=&to=&page=&page_size=` | Super Admin: all entries. Office Head: own office only. Office Staff, Executive: 403 |

`POST /audit-events` takes exactly what `recordAudit` (ccms-shared) sends: `audit_id, actor_user_id, actor_role, action, entity_type,
entity_id, office_id, before_value, after_value, ip_address, occurred_at`. Answers `201 { audit_id, stored: true }`, or
`200 { audit_id, stored: false }` when that `audit_id` was stored before (the first version is kept); `400 VALIDATION_ERROR` with field
details; `401`; `413` over 256 KB. The senders keep an invalid event in their outbox and retry it, with the error visible to developers.

`GET /audit-events` answers `{ items, page, page_size, total }`, newest first (`occurred_at DESC`). Filters combine with AND; `from` and
`to` are Manila dates (`from` 00:00:00 to `to` 23:59:59). The API applies no default date range: the Logs page sends the last 30 days.
Errors use `{ error: { code, message, details, correlation_id, timestamp } }`.

## Turning on delivery (TT2-T3)

Set `LOGS_URL` in `ccms-api-gateway` and `LOGS_SERVICE_URL` in Identity, Core and Operations to this service (`http://127.0.0.1:3002`
for the gateway, `http://127.0.0.1:3002/api` for the others) and use the same `SERVICE_KEY` everywhere. The waiting events are then sent
oldest first, 50 per cron run of each sender (once a day on the current plan, E20); a developer can call a sender's `/api/jobs/outbox`
with its `CRON_SECRET` to send a batch at once. Re-sent events are ignored by `audit_id`.

## Notes

- The logs module has no outbox, no outbound request and no job (BR-LOG-001): audit entries never leave CCMS.
- Indexes: `(occurred_at DESC)`, `(office_id, occurred_at DESC)`, `action`, `entity_type`, `actor_user_id`. A CHECK requires a user unless
  `actor_role = 'system'`. There are no foreign keys (user and office are plain IDs from other services).
- Tables are created from the entities by `npm run db:sync`; constraints, indexes and grants are in `src/lib/after-sync.js` (no migration files, E22 open).

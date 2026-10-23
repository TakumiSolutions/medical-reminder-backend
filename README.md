# Pharmacy Platform — API

Node.js + Express REST API backed by MySQL for the Pharmacy Reminder, WhatsApp Marketing & Order Management Platform (Central and Speedwell branches).

## Requirements

- Node.js 22+
- MySQL 8 or MariaDB 10.4+ (e.g. XAMPP)

## Setup

```bash
npm install
cp .env.example .env            # fill in DB credentials
npm run db:migrate              # creates tables, seeds branches/roles/permissions
npm run create-superadmin       # one-time, interactive; refuses if a Superadmin exists
npm run create-agent -- --branch central --name "Central billing PC"   # optional: RxBridge token
npm run dev                     # http://localhost:4000
```

Create the database first, for example:

```sql
CREATE DATABASE pharmacy_platform CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start with nodemon: restarts on changes to `src/` or `.env` (type `rs` + Enter to restart manually) |
| `npm start` | Start for production |
| `npm run db:migrate` / `db:rollback` | Apply / revert the latest migration batch |
| `npm run db:setup` | Create `DB_NAME` if missing, then migrate (safe on every deploy; used as Render's start step) |
| `npm run create-superadmin` | Bootstrap the first Superadmin (no default credentials exist) |
| `npm run create-agent -- --branch <code> --name "<name>"` | Create a desktop agent (RxBridge) for a branch and print its token once |
| `npm test` | Unit and HTTP tests (no database needed) |
| `npm run lint` | ESLint |

## Structure

```text
src/
  config/        env validation (zod), permission codes
  db/            knex config, migrations, migration CLI
  middleware/    authentication, permission checks, origin (CSRF) check, validation, errors
  routes/        Express routers
  controllers/   HTTP <-> service mapping
  services/      business rules, transactions, audit writes
  repositories/  data access
  validators/    zod request schemas
  scripts/       operational CLI scripts
```

## Authentication and authorization

- Login by **username + password**. Passwords are hashed with scrypt.
- Sessions are server-side rows in `sessions`; the browser holds an opaque token in an httpOnly, SameSite=Lax cookie. Only the SHA-256 of the token is stored.
- Disabling a user, changing their role or resetting their password revokes their sessions. Changing your own password signs out your other sessions.
- State-changing requests must come from an origin in `CORS_ORIGINS` (CSRF defence).
- Permissions come from `role_permissions`, are loaded per request and checked server-side on every protected route.
- User management: **Superadmin manages all users; Admin manages Staff only.** Users cannot disable themselves or change their own role, branches or pages, and the last active Superadmin cannot be disabled or demoted.

### Branch and page access

- **Branches:** Superadmin can access every branch. Admin and Staff only see the branches assigned to them (`user_branches`). Branch-limited users need at least one branch.
- **Pages (modules):** each role sets the maximum pages a user of that role can have. Superadmin or Admin then chooses, per user, which of those pages are on (`user_modules`). Superadmin has every page.
- A permission that belongs to a page (`permissions.module_code`) only applies if the user has that page. Other permissions, such as `branches.read`, always apply.
- An Admin can only assign branches and pages they have themselves, and can only manage Staff whose branches are all within their own. Pages an Admin cannot grant are left untouched when they edit a user.
- Access is loaded on every request, so changes take effect immediately.

- Login is rate-limited (10 failed attempts per 15 minutes per IP).

## Customers

- One customer record per **mobile number** (Indian mobiles, stored as `+91XXXXXXXXXX`), shared across Central and Speedwell. `customer_branches` records which branches the person is a customer of.
- Fields: patient name, mobile (required), address, usual doctor, notes. Doctor, products, batches and prices belong to each bill/order, not the customer.
- Users see customers linked to at least one of their branches. When editing, links to branches outside the editor's access are kept.
- Creating a customer whose mobile already exists links the existing customer to the selected branch instead; their details are not overwritten.
- Customers are never deleted. Two records are never merged automatically; changing a mobile number to one already in use is rejected.

## ProntoZ data (read-only)

Each branch has its own ProntoZ export database (tables `CustomerList` and `CustomerBills`). The **ProntoZ customers** page shows a branch's customers with the medicines on their **last bill**; users only see branches they belong to (Superadmin sees all).

- `PRONTOZ_DB_*` in `.env` must use a database user with **SELECT only** on those databases.
- `PRONTOZ_DATABASES` maps branch codes to databases, e.g. `central:PharmacyExport,speedwell:PharmacyExportSpeedwell`.
- Filter by a medicine to list customers whose last bill contained it.
- **Add** (needs the Customers page with manage rights) copies the customer and the chosen medicines into Customers for that branch. A customer of another branch (same mobile) is linked to this branch with these medicines; their details are not overwritten. Someone already a customer at this branch shows "In customers" and cannot be added again — medicines are not added to existing customers.

Customer medicines are stored per branch (`customer_medicines`). The Customers page shows them and can be filtered by medicine; users only see medicines recorded at their own branches.

## Reminders

Set from the Customers page (**Set reminder**), per medicine:

- Staff choose N days (quick picks 27 / 57 / 87, or any 1–365). Reminders fall on **day N, N+1 and N+2 after the medicine's last bill date**.
- The last bill date is stored when a medicine is added from ProntoZ; if none is stored, the dialog asks for it (never a future date).
- One cycle per scheduling; it does not repeat. A medicine can have only one open reminder at a time.
- Dates already in the past when scheduling are recorded as *skipped* (never sent late). If all three have passed, scheduling is refused.
- **Stop** cancels the remaining dates (with an optional reason).
- When the customer responds, staff mark the reminder **Ordered** (nothing else is entered; the bill is made in ProntoZ and the store delivers) or **Refused** (reason required). Either cancels the remaining dates and moves the customer to the **Ordered** or **Refused** page.
- Outcomes can be undone: switch Ordered ↔ Refused, or **Move back to reminders**, which restores the cancelled dates (dates already passed become *skipped*). Every change is in the audit log.
- Stopped reminders cannot get an outcome, and reminders with an outcome cannot be stopped.
- "Today" uses `APP_TIMEZONE` (default `Asia/Kolkata`).
- **Messages are not sent yet**: reminders are scheduled and shown until a WhatsApp provider is connected.

## Deliveries

Marking a reminder **Ordered** asks how the customer gets the medicine:

- **Home delivery**: address required, pre-filled from the customer. A tick box ("Also save as the customer's address") updates the customer too.
- **Store pickup**: no address.

Each order becomes a delivery on the **Deliveries** page:

- Home delivery: **Pending → Out for delivery → Delivered**. Store pickup: **Ready for pickup → Picked up**.
- Either can be marked **Failed** / **Not collected** (reason required), then **Try again** returns it to pending.
- Deliveries are assigned to an active user of that branch; **My deliveries** shows a user's own.
- Every status change is kept in `delivery_status_history` (shown under **History**) and in the audit log.
- Undoing the order (Ordered → Refused, or back to reminders) cancels a pending or failed delivery. Once it is out for delivery or delivered, the order can no longer be undone.

## Desktop agents (RxBridge)

RxBridge is a Windows agent installed on a branch's billing PC. It reads the billing system's MSSQL database (read-only) and pushes sale bills that carry a customer phone number to this API. Bills are **only stored**; customers are not created or changed from them yet.

### Tables

| Table | Purpose |
| --- | --- |
| `agents` | One row per installed agent: name, branch, SHA-256 of its bearer token (the token itself is never stored), token prefix for display, active/revoked, last seen, latest heartbeat |
| `agent_bills` | One row per bill, unique per `(agent_id, source_database, source_bill_id)` — bill ids restart in each financial-year database. Phone stored as `+91XXXXXXXXXX`, or null when not a valid Indian mobile |
| `agent_bill_items` | Lines of a bill; replaced whenever the bill is sent again |
| `agent_idempotency_keys` | Stored response per `(agent_id, Idempotency-Key)` for 7 days, so retries are answered without re-processing |

The **Desktop agents** page (permission `agents.manage`, Superadmin only) creates agents, rotates or revokes tokens and shows received bills. Status: `never_seen` (no request yet), `online` (heartbeat within 10 minutes), `stale` (no heartbeat for 10 minutes), `revoked`. Create, rotate and revoke are written to the audit log (`agent.created`, `agent.token_rotated`, `agent.revoked`) without the token.

Tokens look like `rxb_` + 43 base64url characters. They are shown **once** (on create or rotate); rotating stops the old token immediately; revoking is permanent (add a new agent instead). From the server: `npm run create-agent -- --branch central --name "Central billing PC"`.

### Agent API (`/api/v1`)

Every request: `Authorization: Bearer <token>`. JSON bodies up to 10 MB after decompression; `Content-Encoding: gzip` (or `deflate`) is accepted. No cookies and no `Origin` check. Errors use the same `{ "error": { "code", "message", "details?" } }` shape.

| Method & path | Request | Response |
| --- | --- | --- |
| `GET /api/v1/ping` | — | 200 `{ "serverTime": "<ISO 8601>", "agentId": "<id>" }` |
| `POST /api/v1/ingest/bills` | `Idempotency-Key` header + bills (below) | 200 `{ "accepted": <number of bills in the request> }` |
| `POST /api/v1/agents/heartbeat` | status (below) | 200 `{ "serverTime": "<ISO 8601>" }` |

```json
{
  "source": { "database": "PC.2026-27", "job": "sale_bills_with_phone" },
  "bills": [
    {
      "id": "104523", "billNo": "S-2041", "series": "HD", "homeDelivery": true, "date": "2026-10-22",
      "phone": "98765 43210", "patient": "Ramesh Kumar", "address": "12, MG Road", "doctor": "Dr. Rao", "total": 1250.5,
      "items": [
        { "product": "PARACETAMOL 650MG TAB", "pack": "15'S", "mfg": "MICRO", "qty": 2, "free": 0, "mrp": 35.2,
          "batch": "B1234", "expiry": "03/27", "rate": 30.17, "gstPct": 12, "gstAmt": 3.62, "amount": 64 }
      ]
    }
  ]
}
```

- 1–1000 bills per request, at most 500 items per bill.
- Required: `source.database` (≤ 32 chars of letters, digits, `_ . -`), `source.job` (≤ 64 chars of letters, digits, `_`), `id` (≤ 64 printable ASCII; the billing system's `TagBillingRef`), `billNo` (≤ 40), `date` (`YYYY-MM-DD`), `total`.
- Everything else may be null, empty or missing. Numbers may be JSON numbers or numeric strings (±100,000,000; `gstPct` ±100); ids and text may be numbers. Text is trimmed and cut to its column size (patient 150, address 500, doctor 150, product 200, pack 40, mfg 100, batch 40, series 20).
- `expiry` is stored as `MM/yy` (`3/27` becomes `03/27`); any other format is stored as null. An invalid `phone` is stored as null — one bad phone never rejects the batch.
- Each bill is upserted by `(agent, source.database, id)` and its items are replaced, all in one transaction. A bill repeated within one request: the last copy wins.

**Idempotency.** `Idempotency-Key` is required (1–128 characters of `A–Z a–z 0–9 _ . : -`, case-sensitive). The server hashes the validated request (`source` + `bills`, keys sorted). A key already used with the same request returns the stored status and body without processing again; with a different request it returns 409 `IDEMPOTENCY_KEY_REUSED`. The key is claimed inside the same transaction as the bills, so concurrent duplicates are processed once and the loser returns the stored response. Keys are kept for 7 days.

Heartbeat body (unknown fields are dropped; only the latest heartbeat is kept):

```json
{ "agentVersion": "1.0.0", "database": "PC.2026-27", "watermarks": { "PC.2026-27": 104523 },
  "outboxCount": 3, "outboxBytes": 20480, "oldestPendingAgeSeconds": 12, "lastError": null,
  "sentAt": "2026-10-23T10:00:00Z" }
```

Status codes:

| Status | `error.code` | When | Agent should |
| --- | --- | --- | --- |
| 400 | `BAD_REQUEST` | Missing/invalid `Idempotency-Key`, validation failed (`details` lists fields), malformed JSON, corrupt gzip | Park the batch as failed |
| 401 | `UNAUTHORIZED` | Missing, malformed, unknown or revoked token | Stop and ask for a new token |
| 404 | `NOT_FOUND` | Unknown `/api/v1` path | — |
| 409 | `IDEMPOTENCY_KEY_REUSED` | Same key, different request | Park as failed (agent bug) |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 10 MB after decompression | Send smaller batches |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Unsupported `Content-Encoding` | Use gzip |
| 429 | `TOO_MANY_REQUESTS` | Over 120 requests a minute per agent, or 100 rejected tokens per 5 minutes per address | Retry after `Retry-After` seconds |
| 500 | `INTERNAL_ERROR` | Server or database problem | Retry with backoff |

### Deployment

- Serve over **HTTPS** only; tokens are bearer credentials.
- The reverse proxy must allow request bodies of at least **10 MB** (e.g. nginx `client_max_body_size 10m;`), pass the `Authorization` and `Idempotency-Key` headers through unchanged, and must not strip `Content-Encoding`.
- Set `trust proxy` (in `src/app.js`) to match the number of proxies so per-address limits see real client addresses.
- Run `npm run db:migrate` to create the agent tables and the `agents.manage` permission, then create an agent (page or CLI) and paste its token into RxBridge.

## API

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/health` | public |
| POST | `/api/auth/login` | public |
| POST | `/api/auth/logout` | signed in |
| GET | `/api/auth/me` | signed in |
| POST | `/api/auth/change-password` | signed in |
| GET | `/api/branches` | `branches.read` |
| GET | `/api/dashboard` | signed in (today's figures per accessible branch; sections follow the user's pages; total across branches when more than one) |
| GET | `/api/users` | `users.read` |
| GET | `/api/users/:id` | `users.read` |
| GET | `/api/users/form-options` | any `users.manage.*` (roles, branches and pages the caller may assign) |
| POST | `/api/users` | `users.manage.<role>` |
| PATCH | `/api/users/:id` | `users.manage.<target role>` |
| POST | `/api/users/:id/reset-password` | `users.manage.<target role>` |
| GET | `/api/audit-logs` | `audit_logs.read` (filters: `action`, `entityType`, `entityId`, `actorUserId`, `from`, `to`) |
| GET | `/api/audit-logs/actions` | `audit_logs.read` |

| GET | `/api/customers` | `customers.read` (`search`, `branchId`, `medicine`, `page`, `pageSize`) |
| GET | `/api/customers/:id` | `customers.read` |
| POST | `/api/customers` | `customers.manage` (200 + `existed: true` when the mobile matched) |
| PATCH | `/api/customers/:id` | `customers.manage` |
| GET | `/api/prontoz/sources` | `prontoz_customers.read` (branches with ProntoZ data the caller can see) |
| GET | `/api/prontoz/customers` | `prontoz_customers.read` (`branchId`, `search`, `medicine`, `mobileStatus=all\|valid\|invalid\|missing`, paging) |
| GET | `/api/prontoz/medicines` | `prontoz_customers.read` (`branchId`) |
| POST | `/api/prontoz/customers/add` | `prontoz_customers.read` + `customers.manage` |
| GET | `/api/customers/medicines` | `customers.read` |
| GET | `/api/reminders` | `reminders.read` (`view=active\|due\|finished\|cancelled\|ordered\|refused`, `search`, paging) |
| GET | `/api/reminders/options` | `reminders.manage` + `customers.read` (`customerId`) |
| POST | `/api/reminders` | `reminders.manage` + `customers.read` |
| POST | `/api/reminders/:id/cancel` | `reminders.manage` |
| POST | `/api/reminders/:id/outcome` | `reminders.manage` (`{ outcome: 'ordered', delivery: { method: 'delivery', address, saveAddress } \| { method: 'pickup' } }` or `{ outcome: 'refused', reason }`) |
| POST | `/api/reminders/:id/reopen` | `reminders.manage` |
| GET | `/api/deliveries` | `deliveries.read` (`status`, `mine=true`, `search`, paging) |
| GET | `/api/deliveries/:id` | `deliveries.read` (includes status history) |
| GET | `/api/deliveries/:id/assignees` | `deliveries.manage` |
| POST | `/api/deliveries/:id/assign` | `deliveries.manage` (`{ userId \| null }`) |
| POST | `/api/deliveries/:id/status` | `deliveries.manage` (`{ status }`, or `{ status: 'failed', note }`) |
| GET | `/api/agents` | `agents.manage` (agents with branch, token prefix, status, last heartbeat, bill counts) |
| POST | `/api/agents` | `agents.manage` (`{ name, branchId }` → 201 `{ agent, token }`) |
| GET | `/api/agents/:id` | `agents.manage` |
| POST | `/api/agents/:id/rotate-token` | `agents.manage` (→ `{ agent, token }`) |
| POST | `/api/agents/:id/revoke` | `agents.manage` (→ `{ agent }`) |
| GET | `/api/agents/:id/bills` | `agents.manage` (`search`, `page`, `pageSize`) |
| GET | `/api/agents/bills/:billId` | `agents.manage` (bill with items) |

User, customer, reminder, delivery and branch lists are limited to the caller's branches.

Errors use one shape: `{ "error": { "code", "message", "details?" } }`.

## Audit log

`audit_logs` records sign-in, failed sign-in (for existing accounts), sign-out, user creation, updates (with before/after values), password changes and resets, and desktop agent creation, token rotation and revocation. Writes share the transaction of the change they describe. IP addresses and device details are not collected. Admin and Superadmin can view it. Entries tied to a branch are shown only to users with access to that branch.

## Time

All database timestamps are stored in UTC.

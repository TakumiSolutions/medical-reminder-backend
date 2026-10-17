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
| `npm run create-superadmin` | Bootstrap the first Superadmin (no default credentials exist) |
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

User, customer, reminder, delivery and branch lists are limited to the caller's branches.

Errors use one shape: `{ "error": { "code", "message", "details?" } }`.

## Audit log

`audit_logs` records sign-in, failed sign-in (for existing accounts), sign-out, user creation, updates (with before/after values), password changes and resets. Writes share the transaction of the change they describe. IP addresses and device details are not collected. Admin and Superadmin can view it. Entries tied to a branch are shown only to users with access to that branch.

## Time

All database timestamps are stored in UTC.

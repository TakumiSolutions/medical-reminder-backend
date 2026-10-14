# Pharmacy Platform — API

Node.js + Express REST API backed by MySQL for the Pharmacy Reminder, WhatsApp Marketing & Order Management Platform (Central and Speedwell branches).

## Requirements

- Node.js 22+
- MySQL 8

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
CREATE DATABASE pharmacy_platform CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
```

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start with file watching |
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

## Contact import

1. **Upload** (`.xlsx` or `.csv`, max 5 MB / 10,000 rows): the branch is chosen at upload. The first row must be headers. Name and Mobile columns are required; Address and Doctor are optional; other columns are ignored and listed. Common header spellings are recognised (e.g. "Patient Name", "Mobile No.", "Dr. Name").
2. **Preview**: every row is validated and classified as `new`, `update`, `unchanged`, `invalid` (e.g. no or bad mobile) or `duplicate` (same mobile earlier in the file). Nothing is written to customers yet.
3. **Confirm**: in a single transaction each row is re-checked against current data and applied. New customers are created; existing ones (matched by mobile) get non-empty imported values for name/address/doctor and are linked to the branch. Blank cells never clear stored data, and notes are never imported. A confirmed or cancelled import cannot be applied again.

Every row's outcome, field changes and resulting customer are kept in `contact_import_rows`. Files are parsed in memory and not stored.

Importing a contact does not record marketing consent.

## API

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/health` | public |
| POST | `/api/auth/login` | public |
| POST | `/api/auth/logout` | signed in |
| GET | `/api/auth/me` | signed in |
| POST | `/api/auth/change-password` | signed in |
| GET | `/api/branches` | `branches.read` |
| GET | `/api/users` | `users.read` |
| GET | `/api/users/:id` | `users.read` |
| GET | `/api/users/form-options` | any `users.manage.*` (roles, branches and pages the caller may assign) |
| POST | `/api/users` | `users.manage.<role>` |
| PATCH | `/api/users/:id` | `users.manage.<target role>` |
| POST | `/api/users/:id/reset-password` | `users.manage.<target role>` |
| GET | `/api/audit-logs` | `audit_logs.read` (filters: `action`, `entityType`, `entityId`, `actorUserId`, `from`, `to`) |
| GET | `/api/audit-logs/actions` | `audit_logs.read` |

| GET | `/api/customers` | `customers.read` (`search`, `branchId`, `page`, `pageSize`) |
| GET | `/api/customers/:id` | `customers.read` |
| POST | `/api/customers` | `customers.manage` (200 + `existed: true` when the mobile matched) |
| PATCH | `/api/customers/:id` | `customers.manage` |
| GET | `/api/contact-imports` | `contact_imports.manage` |
| POST | `/api/contact-imports` | `contact_imports.manage` (multipart: `file`, `branchId`) |
| GET | `/api/contact-imports/template.csv` | `contact_imports.manage` |
| GET | `/api/contact-imports/:id` | `contact_imports.manage` |
| GET | `/api/contact-imports/:id/rows` | `contact_imports.manage` (`status=invalid,duplicate`, paging) |
| POST | `/api/contact-imports/:id/commit` | `contact_imports.manage` |
| POST | `/api/contact-imports/:id/cancel` | `contact_imports.manage` |

User, customer, import and branch lists are limited to the caller's branches.

Errors use one shape: `{ "error": { "code", "message", "details?" } }`.

## Audit log

`audit_logs` records sign-in, failed sign-in (for existing accounts), sign-out, user creation, updates (with before/after values), password changes and resets. Writes share the transaction of the change they describe. IP addresses and device details are not collected. Admin and Superadmin can view it. Entries tied to a branch are shown only to users with access to that branch.

## Time

All database timestamps are stored in UTC.

import { db } from '../db/knex.js';

function toEntry(row) {
  return {
    id: String(row.id),
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    entityLabel: row.target_username ? `@${row.target_username}` : (row.target_customer ?? row.target_import ?? null),
    details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details,
    createdAt: row.created_at,
    actor: row.actor_id ? { id: String(row.actor_id), username: row.actor_username, fullName: row.actor_full_name } : null,
    branch: row.branch_id ? { id: row.branch_id, name: row.branch_name } : null,
  };
}

/**
 * Lists audit entries, newest first. When `branchIds` is an array, branch-specific
 * entries are limited to those branches; entries without a branch are always included.
 */
export async function list({ filters, branchIds, limit, offset }) {
  const query = db('audit_logs');
  if (branchIds) query.where((q) => q.whereNull('audit_logs.branch_id').orWhereIn('audit_logs.branch_id', branchIds));
  if (filters.action) query.where('audit_logs.action', filters.action);
  if (filters.entityType) query.where('audit_logs.entity_type', filters.entityType);
  if (filters.entityId) query.where('audit_logs.entity_id', filters.entityId);
  if (filters.actorUserId) query.where('audit_logs.actor_user_id', filters.actorUserId);
  if (filters.from) query.where('audit_logs.created_at', '>=', `${filters.from} 00:00:00`);
  if (filters.to) query.where('audit_logs.created_at', '<', db.raw('DATE_ADD(?, INTERVAL 1 DAY)', [filters.to]));

  const [{ total }] = await query.clone().count({ total: '*' });
  const rows = await query
    .leftJoin('users as actor', 'actor.id', 'audit_logs.actor_user_id')
    .leftJoin('users as target', function joinTarget() {
      this.on('target.id', '=', 'audit_logs.entity_id').andOn('audit_logs.entity_type', '=', db.raw('?', ['user']));
    })
    .leftJoin('customers as target_customer', function joinCustomer() {
      this.on('target_customer.id', '=', 'audit_logs.entity_id').andOn(
        'audit_logs.entity_type',
        '=',
        db.raw('?', ['customer']),
      );
    })
    .leftJoin('contact_imports as target_import', function joinImport() {
      this.on('target_import.id', '=', 'audit_logs.entity_id').andOn(
        'audit_logs.entity_type',
        '=',
        db.raw('?', ['contact_import']),
      );
    })
    .leftJoin('branches', 'branches.id', 'audit_logs.branch_id')
    .select(
      'audit_logs.*',
      'actor.id as actor_id',
      'actor.username as actor_username',
      'actor.full_name as actor_full_name',
      'target.username as target_username',
      'target_customer.full_name as target_customer',
      'target_import.file_name as target_import',
      'branches.name as branch_name',
    )
    .orderBy('audit_logs.id', 'desc')
    .limit(limit)
    .offset(offset);

  return { items: rows.map(toEntry), total: Number(total) };
}

export async function listActions() {
  return db('audit_logs').distinct('action').orderBy('action').pluck('action');
}

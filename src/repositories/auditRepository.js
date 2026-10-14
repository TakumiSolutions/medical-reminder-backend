import { db } from '../db/knex.js';

/**
 * Records an audit event. Pass the surrounding transaction as `conn` so the audit row
 * commits or rolls back together with the change it describes.
 */
export async function record({ actorUserId, action, entityType, entityId, branchId, details }, conn = db) {
  await conn('audit_logs').insert({
    actor_user_id: actorUserId ?? null,
    action,
    entity_type: entityType ?? null,
    entity_id: entityId == null ? null : String(entityId),
    branch_id: branchId ?? null,
    details: details == null ? null : JSON.stringify(details),
  });
}

import { db } from '../db/knex.js';

const PREVIEW_MAX = 200;
// Outgoing status only moves forward; "failed" can replace any of them.
const STATUS_RANK = { sent: 1, delivered: 2, read: 3 };

const preview = (text) => (text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1)}…` : text);

function toConversation(row) {
  return {
    id: String(row.id),
    branch: { id: row.branch_id, name: row.branch_name },
    waId: row.wa_id,
    mobile: `+${row.wa_id}`,
    profileName: row.profile_name,
    customer: row.customer_id ? { id: String(row.customer_id), fullName: row.customer_name } : null,
    lastMessageAt: row.last_message_at,
    lastMessagePreview: row.last_message_preview,
    lastDirection: row.last_direction,
    lastInboundAt: row.last_inbound_at,
    unreadCount: Number(row.unread_count),
  };
}

function toMessage(row) {
  return {
    id: String(row.id),
    direction: row.direction,
    type: row.type,
    body: row.body,
    status: row.status,
    error: row.error,
    reminderId: row.reminder_id ? String(row.reminder_id) : null,
    sentBy: row.sent_by_name ? { fullName: row.sent_by_name } : null,
    at: row.message_at,
  };
}

const conversationQuery = (conn = db) =>
  conn('whatsapp_conversations as wc')
    .join('branches as b', 'b.id', 'wc.branch_id')
    .leftJoin('customers as cu', 'cu.id', 'wc.customer_id')
    .select('wc.*', 'b.name as branch_name', 'cu.full_name as customer_name');

/** The conversation for (branch, WhatsApp number), created if new. Returns its id. */
export async function upsertConversation(conn, { branchId, waId, customerId = null, profileName = null }) {
  await conn('whatsapp_conversations')
    .insert({ branch_id: branchId, wa_id: waId, customer_id: customerId, profile_name: profileName })
    .onConflict(['branch_id', 'wa_id'])
    .merge({
      profile_name: conn.raw('COALESCE(VALUES(profile_name), profile_name)'),
      customer_id: conn.raw('COALESCE(customer_id, VALUES(customer_id))'),
    });
  const row = await conn('whatsapp_conversations').where({ branch_id: branchId, wa_id: waId }).first('id');
  return String(row.id);
}

/** Stores a message; returns its id, or null when a message with the same WhatsApp id exists. */
export async function insertMessage(conn, { conversationId, direction, waMessageId = null, type, body, status, reminderId = null, sentBy = null, at }) {
  if (waMessageId && (await conn('whatsapp_messages').where({ wa_message_id: waMessageId }).first('id'))) return null;
  const [id] = await conn('whatsapp_messages').insert({
    conversation_id: conversationId,
    direction,
    wa_message_id: waMessageId,
    type,
    body,
    status,
    reminder_id: reminderId,
    sent_by: sentBy,
    message_at: at,
  });

  // Newer than what the list shows: becomes the conversation's latest message.
  await conn('whatsapp_conversations')
    .where({ id: conversationId })
    .where((q) => q.whereNull('last_message_at').orWhere('last_message_at', '<=', at))
    .update({ last_message_at: at, last_message_preview: preview(body ?? `[${type}]`), last_direction: direction });
  if (direction === 'in') {
    await conn('whatsapp_conversations')
      .where({ id: conversationId })
      .update({
        unread_count: conn.raw('unread_count + 1'),
        last_inbound_at: conn.raw('GREATEST(COALESCE(last_inbound_at, ?), ?)', [at, at]),
      });
  }
  return String(id);
}

/**
 * Applies a WhatsApp status update to an outgoing message.
 * @returns the message's reminder id when it belongs to a reminder, else null
 */
export async function updateOutgoingStatus(conn, { waMessageId, status, error }) {
  const row = await conn('whatsapp_messages').where({ wa_message_id: waMessageId, direction: 'out' }).first('id', 'status', 'reminder_id');
  if (!row) return { found: false };
  const moves = status === 'failed' ? row.status !== 'failed' : (STATUS_RANK[status] ?? 0) > (STATUS_RANK[row.status] ?? 0);
  if (moves) {
    await conn('whatsapp_messages')
      .where({ id: row.id })
      .update({ status, error: status === 'failed' ? (error ?? 'Not delivered.').slice(0, 500) : null });
  }
  return { found: true, changed: moves, reminderId: row.reminder_id ? String(row.reminder_id) : null };
}

/** @param scopeBranchIds branches the caller may see (null = all) */
export async function listConversations({ scopeBranchIds, branchId, search, unreadOnly, limit, offset }) {
  const query = conversationQuery();
  if (scopeBranchIds) query.whereIn('wc.branch_id', scopeBranchIds);
  if (branchId) query.where('wc.branch_id', branchId);
  if (unreadOnly) query.where('wc.unread_count', '>', 0);
  if (search) {
    const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    const digits = search.replace(/\D/g, '');
    query.where((q) => {
      q.where('wc.profile_name', 'like', pattern).orWhere('cu.full_name', 'like', pattern);
      if (digits.length >= 3) q.orWhere('wc.wa_id', 'like', `%${digits}%`);
    });
  }
  const [{ total }] = await query.clone().clearSelect().count({ total: '*' });
  const rows = await query.orderByRaw('wc.last_message_at IS NULL, wc.last_message_at DESC').orderBy('wc.id', 'desc').limit(limit).offset(offset);
  return { items: rows.map(toConversation), total: Number(total) };
}

/** Unread conversations per branch the caller may see: { [branchId]: count }. */
export async function unreadByBranch(scopeBranchIds) {
  const query = db('whatsapp_conversations').where('unread_count', '>', 0).groupBy('branch_id').select('branch_id').count({ total: '*' });
  if (scopeBranchIds) query.whereIn('branch_id', scopeBranchIds);
  return Object.fromEntries((await query).map((r) => [r.branch_id, Number(r.total)]));
}

export async function findConversation(id, conn = db) {
  const row = await conversationQuery(conn).where('wc.id', id).first();
  return row ? toConversation(row) : null;
}

/** Messages oldest first; `beforeId` pages back through older ones. */
export async function listMessages(conversationId, { beforeId, limit }) {
  const query = db('whatsapp_messages as m')
    .leftJoin('users as u', 'u.id', 'm.sent_by')
    .where('m.conversation_id', conversationId)
    .select('m.*', 'u.full_name as sent_by_name')
    .orderBy('m.message_at', 'desc')
    .orderBy('m.id', 'desc')
    .limit(limit + 1);
  if (beforeId) query.where('m.id', '<', beforeId);
  const rows = await query;
  return { items: rows.slice(0, limit).reverse().map(toMessage), hasMore: rows.length > limit };
}

export async function markRead(id) {
  await db('whatsapp_conversations').where({ id }).update({ unread_count: 0 });
}

export async function findCustomerIdByMobile(mobile, conn = db) {
  const row = await conn('customers').where({ mobile }).first('id');
  return row ? String(row.id) : null;
}

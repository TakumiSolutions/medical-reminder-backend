// WhatsApp inbox: customer replies arrive through the Meta webhook and are stored per branch
// number; reminders sent and staff replies are stored in the same conversations. Users only
// see conversations of their own branches (Superadmin sees every branch).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { hasBranches } from '../config/permissions.js';
import { whatsappConfigFor } from '../config/whatsapp.js';
import { db } from '../db/knex.js';
import * as accessRepository from '../repositories/accessRepository.js';
import * as auditRepository from '../repositories/auditRepository.js';
import * as inboxRepository from '../repositories/inboxRepository.js';
import { conflict, forbidden, notFound } from '../utils/errors.js';
import { sendText, WhatsAppError } from './whatsappClient.js';

const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

// --- Webhook ---

/** True when `signature` (X-Hub-Signature-256) is the App Secret's HMAC of the raw body. */
export function isValidSignature(rawBody, signature, secret = env.WHATSAPP_APP_SECRET) {
  if (!secret || typeof signature !== 'string' || !signature.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`);
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Readable text for an incoming message of any type. */
export function describeIncoming(message) {
  const caption = (media, label) => [label, media?.caption ?? media?.filename].filter(Boolean).join(' ');
  switch (message.type) {
    case 'text':
      return message.text?.body ?? '';
    case 'button':
      return message.button?.text ?? '[Button]';
    case 'interactive':
      return message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title ?? '[Reply]';
    case 'image':
      return caption(message.image, '[Photo]');
    case 'video':
      return caption(message.video, '[Video]');
    case 'document':
      return caption(message.document, '[Document]');
    case 'audio':
      return message.audio?.voice ? '[Voice message]' : '[Audio]';
    case 'sticker':
      return '[Sticker]';
    case 'reaction':
      return message.reaction?.emoji ? `Reacted ${message.reaction.emoji}` : '[Reaction removed]';
    case 'location': {
      const l = message.location ?? {};
      return ['[Location]', l.name, l.address, l.latitude != null ? `${l.latitude}, ${l.longitude}` : null].filter(Boolean).join(' ');
    }
    case 'contacts':
      return `[Contact] ${message.contacts?.[0]?.name?.formatted_name ?? ''}`.trim();
    default:
      return `[${message.type ?? 'Message'} not supported]`;
  }
}

/** Branch id per configured WhatsApp phone number id. */
async function branchesByPhoneNumberId() {
  const map = new Map();
  for (const branch of await accessRepository.listActiveBranches()) {
    const config = whatsappConfigFor(branch.code);
    if (config) map.set(config.phoneNumberId, branch.id);
  }
  return map;
}

const fromUnix = (seconds) => (seconds ? new Date(Number(seconds) * 1000) : new Date());

async function storeIncoming(branchId, message, contacts) {
  const waId = String(message.from ?? '').replace(/\D/g, '');
  if (!waId) return;
  const profileName = contacts?.find((c) => c.wa_id === message.from)?.profile?.name?.slice(0, 150) ?? null;
  await db.transaction(async (trx) => {
    const customerId = await inboxRepository.findCustomerIdByMobile(`+${waId}`, trx);
    const conversationId = await inboxRepository.upsertConversation(trx, { branchId, waId, customerId, profileName });
    await inboxRepository.insertMessage(trx, {
      conversationId,
      direction: 'in',
      waMessageId: message.id,
      type: String(message.type ?? 'unknown').slice(0, 20),
      body: describeIncoming(message),
      status: 'received',
      at: fromUnix(message.timestamp),
    });
  });
}

async function storeStatus(status) {
  const error = status.errors?.[0];
  const reason = error ? [error.title ?? error.message, error.error_data?.details].filter(Boolean).join(' — ') : null;
  const result = await inboxRepository.updateOutgoingStatus(db, { waMessageId: status.id, status: status.status, error: reason });
  // A reminder WhatsApp could not deliver after accepting it (e.g. the number is not on WhatsApp).
  if (result.changed && status.status === 'failed' && result.reminderId) {
    await db('reminders')
      .where({ id: result.reminderId, status: 'sent' })
      .update({ status: 'failed', failure_reason: (reason ?? 'Not delivered.').slice(0, 500), status_changed_at: db.fn.now() });
  }
}

/** Stores the messages and status updates of one webhook delivery. */
export async function handleWebhook(payload) {
  if (payload?.object !== 'whatsapp_business_account') return;
  const branches = await branchesByPhoneNumberId();
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue;
      const value = change.value ?? {};
      const branchId = branches.get(value.metadata?.phone_number_id);
      if (!branchId) {
        console.warn(`WhatsApp webhook for unknown number ${value.metadata?.phone_number_id}; ignored.`);
        continue;
      }
      for (const message of value.messages ?? []) await storeIncoming(branchId, message, value.contacts);
      for (const status of value.statuses ?? []) await storeStatus(status);
    }
  }
}

// --- Reminders sent ---

/** Adds a sent reminder to the customer's conversation with that branch. */
export async function recordReminderSent({ branchId, mobile, customerId, reminderId, waMessageId, body }) {
  await db.transaction(async (trx) => {
    const conversationId = await inboxRepository.upsertConversation(trx, { branchId, waId: mobile.replace(/^\+/, ''), customerId });
    await inboxRepository.insertMessage(trx, {
      conversationId,
      direction: 'out',
      waMessageId,
      type: 'reminder',
      body,
      status: 'sent',
      reminderId,
      at: new Date(),
    });
  });
}

/** Records a bill sent as a PDF (automatically or by `sentBy`) in the branch's inbox. */
export async function recordBillSent({ branchId, mobile, customerId, waMessageId, sentBy = null, body }) {
  await db.transaction(async (trx) => {
    const conversationId = await inboxRepository.upsertConversation(trx, { branchId, waId: mobile.replace(/^\+/, ''), customerId });
    await inboxRepository.insertMessage(trx, {
      conversationId,
      direction: 'out',
      waMessageId,
      type: 'document',
      body,
      status: 'sent',
      sentBy,
      at: new Date(),
    });
  });
}

// --- Inbox pages ---

async function loadConversation(auth, id) {
  const conversation = await inboxRepository.findConversation(id);
  if (!conversation || !hasBranches(auth, [conversation.branch.id])) throw notFound('Conversation not found.');
  return conversation;
}

const replyWindowOpen = (conversation, now = Date.now()) =>
  Boolean(conversation.lastInboundAt) && now - new Date(conversation.lastInboundAt).getTime() < REPLY_WINDOW_MS;

export async function listConversations(auth, { branchId, search, unreadOnly, page, pageSize }) {
  if (branchId && !hasBranches(auth, [branchId])) throw forbidden('You do not have access to that branch.');
  const [{ items, total }, unread, branches] = await Promise.all([
    inboxRepository.listConversations({
      scopeBranchIds: auth.branchIds,
      branchId,
      search,
      unreadOnly,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    }),
    inboxRepository.unreadByBranch(auth.branchIds),
    accessRepository.listActiveBranches(),
  ]);
  return {
    items,
    // Branches the caller can see, with whether WhatsApp is set up and unread conversations.
    branches: branches
      .filter((b) => hasBranches(auth, [b.id]))
      .map((b) => ({ id: b.id, name: b.name, configured: Boolean(whatsappConfigFor(b.code)), unread: unread[b.id] ?? 0 })),
    page,
    pageSize,
    total,
  };
}

export async function getMessages(auth, id, { beforeId, limit }) {
  const conversation = await loadConversation(auth, id);
  const branch = (await accessRepository.listActiveBranches()).find((b) => b.id === conversation.branch.id);
  const messages = await inboxRepository.listMessages(id, { beforeId, limit });
  return {
    conversation: { ...conversation, canReply: replyWindowOpen(conversation) && Boolean(branch && whatsappConfigFor(branch.code)) },
    ...messages,
  };
}

export async function markRead(auth, id) {
  await loadConversation(auth, id);
  await inboxRepository.markRead(id);
}

/** Sends a free-text reply from the conversation's branch number. */
export async function reply(auth, id, { text }) {
  const conversation = await loadConversation(auth, id);
  if (!replyWindowOpen(conversation)) {
    throw conflict('WhatsApp only allows replies within 24 hours of the customer’s last message.');
  }
  const branch = (await accessRepository.listActiveBranches()).find((b) => b.id === conversation.branch.id);
  const config = branch && whatsappConfigFor(branch.code);
  if (!config) throw conflict(`WhatsApp is not set up for ${conversation.branch.name}.`);

  let waMessageId;
  try {
    waMessageId = await sendText(config, { mobile: conversation.mobile, text });
  } catch (error) {
    if (error instanceof WhatsAppError) throw conflict(`WhatsApp did not accept the message. ${error.message}`);
    throw error;
  }
  await db.transaction(async (trx) => {
    await inboxRepository.insertMessage(trx, {
      conversationId: id,
      direction: 'out',
      waMessageId,
      type: 'text',
      body: text,
      status: 'sent',
      sentBy: auth.user.id,
      at: new Date(),
    });
    await auditRepository.record(
      {
        actorUserId: auth.user.id,
        action: 'whatsapp.replied',
        entityType: 'customer',
        entityId: conversation.customer?.id ?? null,
        branchId: conversation.branch.id,
        details: { mobile: conversation.mobile, text },
      },
      trx,
    );
  });
  await inboxRepository.markRead(id);
}

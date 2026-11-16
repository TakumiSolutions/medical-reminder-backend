import { Router } from 'express';
import { z } from 'zod';
import { PERMISSIONS } from '../config/permissions.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as inboxService from '../services/inboxService.js';

const byId = validate({ params: z.object({ id: z.string().regex(/^\d+$/, 'Invalid conversation id.') }) });

const listQuerySchema = z.object({
  branchId: z.coerce.number().int().positive().optional(),
  search: z.string().trim().max(100).optional(),
  unreadOnly: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
});

const messagesQuerySchema = z.object({
  beforeId: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const replySchema = z.object({
  text: z.string({ error: 'Type a message.' }).trim().min(1, 'Type a message.').max(4096, 'At most 4096 characters.'),
});

export const inboxRoutes = Router();

inboxRoutes.use(authenticate, requirePermission(PERMISSIONS.WHATSAPP_INBOX_READ));

inboxRoutes.get('/conversations', validate({ query: listQuerySchema }), async (req, res) => {
  res.json(await inboxService.listConversations(req.auth, req.validatedQuery));
});

inboxRoutes.get('/conversations/:id/messages', byId, validate({ query: messagesQuerySchema }), async (req, res) => {
  res.json(await inboxService.getMessages(req.auth, req.params.id, req.validatedQuery));
});

inboxRoutes.post('/conversations/:id/read', byId, async (req, res) => {
  await inboxService.markRead(req.auth, req.params.id);
  res.status(204).end();
});

inboxRoutes.post(
  '/conversations/:id/messages',
  byId,
  requirePermission(PERMISSIONS.WHATSAPP_INBOX_REPLY),
  validate({ body: replySchema }),
  async (req, res) => {
    await inboxService.reply(req.auth, req.params.id, req.body);
    res.status(201).json({ ok: true });
  },
);

import { Router } from 'express';
import { z } from 'zod';
import { PERMISSIONS } from '../config/permissions.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as deliveryService from '../services/deliveryService.js';

const byId = validate({ params: z.object({ id: z.string().regex(/^\d+$/, 'Invalid delivery id.') }) });
const canManage = requirePermission(PERMISSIONS.DELIVERIES_MANAGE);

const listQuerySchema = z.object({
  status: z.enum(['pending', 'out_for_delivery', 'delivered', 'failed', 'cancelled']).default('pending'),
  mine: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const assignSchema = z.object({ userId: z.string().regex(/^\d+$/).nullable() });

const statusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.enum(['out_for_delivery', 'delivered', 'pending']) }),
  z.object({
    status: z.literal('failed'),
    note: z.string({ error: 'Enter the reason.' }).trim().min(1, 'Enter the reason.').max(500),
  }),
]);

export const deliveryRoutes = Router();

deliveryRoutes.use(authenticate, requirePermission(PERMISSIONS.DELIVERIES_READ));

deliveryRoutes.get('/', validate({ query: listQuerySchema }), async (req, res) => {
  res.json(await deliveryService.listDeliveries(req.auth, req.validatedQuery));
});

deliveryRoutes.get('/:id', byId, async (req, res) => {
  res.json({ delivery: await deliveryService.getDelivery(req.auth, req.params.id) });
});

deliveryRoutes.get('/:id/assignees', byId, canManage, async (req, res) => {
  res.json({ users: await deliveryService.listAssignees(req.auth, req.params.id) });
});

deliveryRoutes.post('/:id/assign', byId, canManage, validate({ body: assignSchema }), async (req, res) => {
  res.json({ delivery: await deliveryService.assign(req.auth, req.params.id, req.body) });
});

deliveryRoutes.post('/:id/status', byId, canManage, validate({ body: statusSchema }), async (req, res) => {
  res.json({ delivery: await deliveryService.changeStatus(req.auth, req.params.id, req.body) });
});

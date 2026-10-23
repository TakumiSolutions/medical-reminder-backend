import { Router } from 'express';
import { z } from 'zod';
import { PERMISSIONS } from '../config/permissions.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as agentService from '../services/agentService.js';
import { createAgentSchema, listAgentBillsQuerySchema } from '../validators/agentValidators.js';

const byId = validate({ params: z.object({ id: z.string().regex(/^\d+$/, 'Invalid agent id.') }) });
const byBillId = validate({ params: z.object({ billId: z.string().regex(/^\d+$/, 'Invalid bill id.') }) });

export const agentRoutes = Router();

agentRoutes.use(authenticate, requirePermission(PERMISSIONS.AGENTS_MANAGE));

agentRoutes.get('/', async (req, res) => {
  res.json({ agents: await agentService.listAgents(req.auth) });
});

agentRoutes.post('/', validate({ body: createAgentSchema }), async (req, res) => {
  res.status(201).json(await agentService.createAgent(req.auth, req.body));
});

agentRoutes.get('/bills/:billId', byBillId, async (req, res) => {
  res.json({ bill: await agentService.getBill(req.auth, req.params.billId) });
});

agentRoutes.get('/:id', byId, async (req, res) => {
  res.json({ agent: await agentService.getAgent(req.auth, req.params.id) });
});

agentRoutes.post('/:id/rotate-token', byId, async (req, res) => {
  res.json(await agentService.rotateToken(req.auth, req.params.id));
});

agentRoutes.post('/:id/revoke', byId, async (req, res) => {
  res.json({ agent: await agentService.revokeAgent(req.auth, req.params.id) });
});

agentRoutes.get('/:id/bills', byId, validate({ query: listAgentBillsQuerySchema }), async (req, res) => {
  res.json(await agentService.listBills(req.auth, req.params.id, req.validatedQuery));
});

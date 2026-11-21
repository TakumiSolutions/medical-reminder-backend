import { Router } from 'express';
import { z } from 'zod';
import { PERMISSIONS } from '../config/permissions.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as customerService from '../services/customerService.js';
import * as promptCustomerService from '../services/promptCustomerService.js';
import { addFromPromptSchema } from '../validators/customerValidators.js';

const optionalBranchQuery = { branchId: z.coerce.number().int().positive().optional() };

const listQuerySchema = z.object({
  ...optionalBranchQuery,
  search: z.string().trim().max(100).optional(),
  mobileStatus: z.enum(['all', 'valid', 'invalid', 'missing']).default('all'),
  medicine: z.string().trim().min(1).max(100).optional(),
  reminderStatus: z.enum(['in_reminders', 'not_in_reminders']).optional(),
  billDateFrom: z.iso.date().optional(),
  billDateTo: z.iso.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
}).refine(
  ({ billDateFrom, billDateTo }) => !billDateFrom || !billDateTo || billDateFrom <= billDateTo,
  { path: ['billDateTo'], message: 'End date must be on or after start date.' },
);

export const promptRoutes = Router();

promptRoutes.use(authenticate, requirePermission(PERMISSIONS.PROMPT_CUSTOMERS_READ));

promptRoutes.get('/sources', async (req, res) => {
  res.json({ branches: await promptCustomerService.listSources(req.auth) });
});

promptRoutes.get('/customers', validate({ query: listQuerySchema }), async (req, res) => {
  res.json(await promptCustomerService.listCustomers(req.auth, req.validatedQuery));
});

promptRoutes.get('/medicines', validate({ query: z.object(optionalBranchQuery) }), async (req, res) => {
  res.json({ medicines: await promptCustomerService.listMedicines(req.auth, req.validatedQuery) });
});

// Copies a Prompt customer and chosen medicines into the cloud Customers list.
promptRoutes.post(
  '/customers/add',
  requirePermission(PERMISSIONS.CUSTOMERS_MANAGE),
  validate({ body: addFromPromptSchema }),
  async (req, res) => {
    const result = await customerService.addFromPrompt(req.auth, req.body);
    res.status(result.existed ? 200 : 201).json(result);
  },
);

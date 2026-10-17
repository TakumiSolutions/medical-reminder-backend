import { Router } from 'express';
import { z } from 'zod';
import { PERMISSIONS } from '../config/permissions.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as customerService from '../services/customerService.js';
import * as prontozCustomerService from '../services/prontozCustomerService.js';
import { addFromProntozSchema } from '../validators/customerValidators.js';

const branchQuery = { branchId: z.coerce.number().int().positive({ error: 'Choose a branch.' }) };

const listQuerySchema = z.object({
  ...branchQuery,
  search: z.string().trim().max(100).optional(),
  mobileStatus: z.enum(['all', 'valid', 'invalid', 'missing']).default('all'),
  medicine: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export const prontozRoutes = Router();

prontozRoutes.use(authenticate, requirePermission(PERMISSIONS.PRONTOZ_CUSTOMERS_READ));

prontozRoutes.get('/sources', async (req, res) => {
  res.json({ branches: await prontozCustomerService.listSources(req.auth) });
});

prontozRoutes.get('/customers', validate({ query: listQuerySchema }), async (req, res) => {
  res.json(await prontozCustomerService.listCustomers(req.auth, req.validatedQuery));
});

prontozRoutes.get('/medicines', validate({ query: z.object(branchQuery) }), async (req, res) => {
  res.json({ medicines: await prontozCustomerService.listMedicines(req.auth, req.validatedQuery) });
});

// Copies a ProntoZ customer and chosen medicines into the cloud Customers list.
prontozRoutes.post(
  '/customers/add',
  requirePermission(PERMISSIONS.CUSTOMERS_MANAGE),
  validate({ body: addFromProntozSchema }),
  async (req, res) => {
    const result = await customerService.addFromProntoz(req.auth, req.body);
    res.status(result.existed ? 200 : 201).json(result);
  },
);

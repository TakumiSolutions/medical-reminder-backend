import { Router } from 'express';
import { PERMISSIONS } from '../config/permissions.js';
import * as customerController from '../controllers/customerController.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  createCustomerSchema,
  customerIdParamsSchema,
  listCustomersQuerySchema,
  updateCustomerSchema,
} from '../validators/customerValidators.js';

const canRead = requirePermission(PERMISSIONS.CUSTOMERS_READ);
const canManage = requirePermission(PERMISSIONS.CUSTOMERS_MANAGE);
const byId = validate({ params: customerIdParamsSchema });

export const customerRoutes = Router();

customerRoutes.use(authenticate);

customerRoutes.get('/', canRead, validate({ query: listCustomersQuerySchema }), customerController.list);
customerRoutes.get('/:id', canRead, byId, customerController.get);
customerRoutes.post('/', canManage, validate({ body: createCustomerSchema }), customerController.create);
customerRoutes.patch('/:id', canManage, byId, validate({ body: updateCustomerSchema }), customerController.update);

import { Router } from 'express';
import { PERMISSIONS } from '../config/permissions.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as auditLogQueryRepository from '../repositories/auditLogQueryRepository.js';
import { listAuditLogsQuerySchema } from '../validators/auditLogValidators.js';

export const auditLogRoutes = Router();

auditLogRoutes.use(authenticate, requirePermission(PERMISSIONS.AUDIT_LOGS_READ));

auditLogRoutes.get('/', validate({ query: listAuditLogsQuerySchema }), async (req, res) => {
  const { page, pageSize, ...filters } = req.validatedQuery;
  const { items, total } = await auditLogQueryRepository.list({
    filters,
    branchIds: req.auth.branchIds,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  res.json({ items, page, pageSize, total });
});

auditLogRoutes.get('/actions', async (_req, res) => {
  res.json({ actions: await auditLogQueryRepository.listActions() });
});

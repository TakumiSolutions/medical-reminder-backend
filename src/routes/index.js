import { Router } from 'express';
import { hasBranches, PERMISSIONS } from '../config/permissions.js';
import { db } from '../db/knex.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import * as accessRepository from '../repositories/accessRepository.js';
import { auditLogRoutes } from './auditLogRoutes.js';
import { authRoutes } from './authRoutes.js';
import { contactImportRoutes } from './contactImportRoutes.js';
import { customerRoutes } from './customerRoutes.js';
import { userRoutes } from './userRoutes.js';

export const apiRoutes = Router();

apiRoutes.get('/health', async (_req, res) => {
  try {
    await db.raw('SELECT 1');
    res.json({ status: 'ok', database: 'ok' });
  } catch {
    res.status(503).json({ status: 'degraded', database: 'unavailable' });
  }
});

apiRoutes.use('/auth', authRoutes);
apiRoutes.use('/users', userRoutes);
apiRoutes.use('/audit-logs', auditLogRoutes);
apiRoutes.use('/customers', customerRoutes);
apiRoutes.use('/contact-imports', contactImportRoutes);

// Only the branches the caller has access to.
apiRoutes.get('/branches', authenticate, requirePermission(PERMISSIONS.BRANCHES_READ), async (req, res) => {
  const branches = await accessRepository.listActiveBranches();
  res.json({ branches: branches.filter((b) => hasBranches(req.auth, [b.id])) });
});

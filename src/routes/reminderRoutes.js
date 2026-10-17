import { Router } from 'express';
import { PERMISSIONS } from '../config/permissions.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as reminderService from '../services/reminderService.js';
import {
  cancelReminderSchema,
  cycleIdParamsSchema,
  listRemindersQuerySchema,
  recordOutcomeSchema,
  scheduleOptionsQuerySchema,
  scheduleRemindersSchema,
} from '../validators/reminderValidators.js';

const canManage = requirePermission(PERMISSIONS.REMINDERS_MANAGE);

export const reminderRoutes = Router();

reminderRoutes.use(authenticate);

reminderRoutes.get(
  '/',
  requirePermission(PERMISSIONS.REMINDERS_READ),
  validate({ query: listRemindersQuerySchema }),
  async (req, res) => {
    res.json(await reminderService.listCycles(req.auth, req.validatedQuery));
  },
);

// Used from the Customers page, so it also needs customer access.
reminderRoutes.get(
  '/options',
  canManage,
  requirePermission(PERMISSIONS.CUSTOMERS_READ),
  validate({ query: scheduleOptionsQuerySchema }),
  async (req, res) => {
    res.json(await reminderService.getScheduleOptions(req.auth, req.validatedQuery.customerId));
  },
);

reminderRoutes.post(
  '/',
  canManage,
  requirePermission(PERMISSIONS.CUSTOMERS_READ),
  validate({ body: scheduleRemindersSchema }),
  async (req, res) => {
    const ids = await reminderService.schedule(req.auth, req.body);
    res.status(201).json({ cycleIds: ids });
  },
);

reminderRoutes.post(
  '/:id/cancel',
  canManage,
  validate({ params: cycleIdParamsSchema, body: cancelReminderSchema }),
  async (req, res) => {
    res.json({ reminder: await reminderService.cancelCycle(req.auth, req.params.id, req.body) });
  },
);

// Customer ordered or refused (also used to switch between the two).
reminderRoutes.post(
  '/:id/outcome',
  canManage,
  validate({ params: cycleIdParamsSchema, body: recordOutcomeSchema }),
  async (req, res) => {
    res.json({ reminder: await reminderService.recordOutcome(req.auth, req.params.id, req.body) });
  },
);

// Undo the outcome: back to the reminder list.
reminderRoutes.post('/:id/reopen', canManage, validate({ params: cycleIdParamsSchema }), async (req, res) => {
  res.json({ reminder: await reminderService.reopen(req.auth, req.params.id) });
});

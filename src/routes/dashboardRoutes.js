import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import * as dashboardService from '../services/dashboardService.js';

export const dashboardRoutes = Router();

// Every signed-in user has a dashboard; its sections follow their pages and branches.
dashboardRoutes.get('/', authenticate, async (req, res) => {
  res.json(await dashboardService.getDashboard(req.auth));
});

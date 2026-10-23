// API for the RxBridge desktop agents (/api/v1). Bearer-token authentication, no cookies,
// so it is mounted ahead of the browser API's body parser, cookie parser and origin check.
import express, { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { authenticateAgent, requireIdempotencyKey } from '../middleware/agentAuth.js';
import { notFoundHandler } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import * as agentApiService from '../services/agentApiService.js';
import { heartbeatSchema, ingestBillsSchema } from '../validators/agentValidators.js';

const tooManyRequests = { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests. Retry later.' } };

// Per address, only counting rejected tokens: stops token guessing from loading the database.
const failedAuthLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  requestWasSuccessful: (_req, res) => res.statusCode !== 401,
  skipSuccessfulRequests: true,
  message: tooManyRequests,
});

// Per agent. An agent polls every 5–10 s and sends a heartbeat each minute; the headroom
// lets it drain a backlog. 429 responses carry Retry-After, which the agent honours.
const agentLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => `agent:${req.agent.id}`,
  message: tooManyRequests,
});

export const agentApiRoutes = Router();

// Authenticate before reading a (up to 10 MB, gzip-inflated) body.
agentApiRoutes.use(failedAuthLimiter, authenticateAgent, agentLimiter, express.json({ limit: '10mb' }));

agentApiRoutes.get('/ping', (req, res) => {
  res.json({ serverTime: new Date().toISOString(), agentId: req.agent.id });
});

agentApiRoutes.post('/ingest/bills', requireIdempotencyKey, validate({ body: ingestBillsSchema }), async (req, res) => {
  const { status, body } = await agentApiService.ingestBills(req.agent, req.idempotencyKey, req.body);
  res.status(status).json(body);
});

agentApiRoutes.post('/agents/heartbeat', validate({ body: heartbeatSchema }), async (req, res) => {
  res.json(await agentApiService.recordHeartbeat(req.agent, req.body));
});

// Unknown /api/v1 paths end here instead of falling through to the browser API.
agentApiRoutes.use(notFoundHandler);

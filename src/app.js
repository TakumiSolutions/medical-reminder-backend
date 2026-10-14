import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { requireAllowedOrigin } from './middleware/originCheck.js';
import { apiRoutes } from './routes/index.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  // Set to the number of reverse proxies in front of the API when deployed, so rate
  // limiting sees real client addresses.
  app.set('trust proxy', env.NODE_ENV === 'production' ? 1 : false);

  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGINS, credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.use('/api', requireAllowedOrigin(env.CORS_ORIGINS), apiRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

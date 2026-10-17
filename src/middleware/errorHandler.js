import { AppError, notFound } from '../utils/errors.js';

export function notFoundHandler(_req, _res, next) {
  next(notFound('Endpoint not found.'));
}

export function errorHandler(error, req, res, _next) {
  if (error instanceof AppError) {
    return res.status(error.status).json({
      error: { code: error.code, message: error.message, ...(error.details && { details: error.details }) },
    });
  }

  // Malformed JSON body from express.json().
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Malformed JSON body.' } });
  }
  if (error.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' } });
  }

  console.error(`[${req.method} ${req.originalUrl}]`, error);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } });
}

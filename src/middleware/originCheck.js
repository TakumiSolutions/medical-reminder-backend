import { forbidden } from '../utils/errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for cookie-authenticated requests: state-changing requests must come
 * from an allowed origin. Complements the SameSite session cookie.
 */
export function requireAllowedOrigin(allowedOrigins) {
  const allowed = new Set(allowedOrigins);
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();

    const origin = req.get('origin') ?? originFromReferer(req.get('referer'));
    if (!origin || !allowed.has(origin)) return next(forbidden('Request origin is not allowed.'));
    next();
  };
}

function originFromReferer(referer) {
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

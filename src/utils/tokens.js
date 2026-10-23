import { createHash, randomBytes } from 'node:crypto';

export const generateSessionToken = () => randomBytes(32).toString('base64url');

// Desktop agent bearer tokens: "rxb_" + 32 random bytes (base64url, 43 characters).
export const AGENT_TOKEN_PATTERN = /^rxb_[A-Za-z0-9_-]{43}$/;
export const generateAgentToken = () => `rxb_${randomBytes(32).toString('base64url')}`;

export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

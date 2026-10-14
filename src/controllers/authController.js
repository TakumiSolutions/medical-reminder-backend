import { env } from '../config/env.js';
import * as authService from '../services/authService.js';

const cookieOptions = {
  httpOnly: true,
  secure: env.SESSION_COOKIE_SECURE,
  sameSite: 'lax',
  path: '/',
};

export async function login(req, res) {
  const { token, expiresAt } = await authService.login(req.body);
  res.cookie(env.SESSION_COOKIE_NAME, token, { ...cookieOptions, expires: expiresAt });
  res.status(204).end();
}

export async function logout(req, res) {
  await authService.logout(req.auth);
  res.clearCookie(env.SESSION_COOKIE_NAME, cookieOptions);
  res.status(204).end();
}

export function me(req, res) {
  res.json({ user: authService.toCurrentUser(req.auth) });
}

export async function changePassword(req, res) {
  await authService.changePassword(req.auth, req.body);
  res.status(204).end();
}

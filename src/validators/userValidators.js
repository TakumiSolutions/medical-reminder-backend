import { z } from 'zod';
import { ROLE_CODES } from '../config/permissions.js';

export const usernameField = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Username must be at least 3 characters.')
  .max(50, 'Username must be at most 50 characters.')
  .regex(/^[a-z0-9._@-]+$/, 'Username may only contain letters, numbers, dots, hyphens, underscores and @.');

// Interim policy pending business confirmation: length-based, no composition rules.
export const newPasswordField = z
  .string()
  .min(8, 'Password must be at least 8 characters.')
  .max(128, 'Password must be at most 128 characters.');

export const fullNameField = z.string().trim().min(1, 'Full name is required.').max(150);
const roleField = z.enum(ROLE_CODES);
const branchIdsField = z.array(z.number().int().positive()).max(50).transform((ids) => [...new Set(ids)]);
const modulesField = z
  .array(z.string().regex(/^[a-z_]{1,50}$/))
  .max(50)
  .transform((codes) => [...new Set(codes)]);

export const loginSchema = z.object({
  username: z.string().trim().toLowerCase().min(1).max(50),
  password: z.string().min(1).max(128),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: newPasswordField,
});

export const userIdParamsSchema = z.object({
  id: z.string().regex(/^\d+$/, 'Invalid user id.'),
});

export const listUsersQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const createUserSchema = z.object({
  username: usernameField,
  fullName: fullNameField,
  password: newPasswordField,
  role: roleField,
  branchIds: branchIdsField.default([]),
  modules: modulesField.default([]),
});

export const updateUserSchema = z
  .object({
    fullName: fullNameField.optional(),
    isActive: z.boolean().optional(),
    role: roleField.optional(),
    branchIds: branchIdsField.optional(),
    modules: modulesField.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No changes supplied.' });

export const resetPasswordSchema = z.object({
  password: newPasswordField,
});

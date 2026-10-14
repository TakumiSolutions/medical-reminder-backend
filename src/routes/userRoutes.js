import { Router } from 'express';
import { canManageAnyUsers, PERMISSIONS } from '../config/permissions.js';
import * as userController from '../controllers/userController.js';
import { authenticate, requirePermission, requirePermissionWhere } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  createUserSchema,
  listUsersQuerySchema,
  resetPasswordSchema,
  updateUserSchema,
  userIdParamsSchema,
} from '../validators/userValidators.js';

// Which specific roles the caller may manage is checked in userService against the target user.
const canManageUsers = requirePermissionWhere(canManageAnyUsers);
const byId = validate({ params: userIdParamsSchema });

export const userRoutes = Router();

userRoutes.use(authenticate);

userRoutes.get('/', requirePermission(PERMISSIONS.USERS_READ), validate({ query: listUsersQuerySchema }), userController.list);
userRoutes.get('/form-options', canManageUsers, userController.formOptions);
userRoutes.get('/:id', requirePermission(PERMISSIONS.USERS_READ), byId, userController.get);
userRoutes.post('/', canManageUsers, validate({ body: createUserSchema }), userController.create);
userRoutes.patch('/:id', canManageUsers, byId, validate({ body: updateUserSchema }), userController.update);
userRoutes.post(
  '/:id/reset-password',
  canManageUsers,
  byId,
  validate({ body: resetPasswordSchema }),
  userController.resetPassword,
);

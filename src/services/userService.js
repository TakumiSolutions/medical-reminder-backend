import { assignableRoles, canManageRoles, hasBranches } from '../config/permissions.js';
import { db } from '../db/knex.js';
import * as accessRepository from '../repositories/accessRepository.js';
import * as auditRepository from '../repositories/auditRepository.js';
import * as sessionRepository from '../repositories/sessionRepository.js';
import * as userRepository from '../repositories/userRepository.js';
import { conflict, forbidden, notFound } from '../utils/errors.js';
import { hashPassword } from '../utils/password.js';
import { grantableModules, resolveAccessAssignment } from './userAccessRules.js';

const USERNAME_TAKEN = 'That username is already in use.';

const branchIdsOf = (user) => user.branches.map((b) => b.id);
const sameList = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);

/** Branch-limited viewers only see users who share at least one of their branches. */
function isVisibleTo(auth, user) {
  if (auth.branchIds === null) return true;
  const own = new Set(auth.branchIds);
  return user.branches.some((b) => own.has(b.id));
}

export async function listUsers(auth, { search, page, pageSize }) {
  const { items, total } = await userRepository.list({
    search,
    limit: pageSize,
    offset: (page - 1) * pageSize,
    branchIds: auth.branchIds,
  });
  return { items, page, pageSize, total };
}

export async function getUser(auth, id) {
  const user = await userRepository.findById(id);
  if (!user || !isVisibleTo(auth, user)) throw notFound('User not found.');
  return user;
}

/** Roles, branches and pages the caller may assign, for the user form. */
export async function getFormOptions(auth) {
  const [roleDefs, branches] = await Promise.all([
    accessRepository.loadRoleDefinitions(),
    accessRepository.listActiveBranches(),
  ]);
  const grantable = (def) => new Set(grantableModules(auth, def));
  return {
    roles: assignableRoles(auth.permissions).map((code) => {
      const def = roleDefs[code];
      const allowed = grantable(def);
      return {
        code: def.code,
        name: def.name,
        allBranches: def.allBranches,
        allModules: def.allModules,
        modules: def.modules.filter((m) => allowed.has(m.code)),
      };
    }),
    branches: branches.filter((b) => hasBranches(auth, [b.id])),
  };
}

async function loadAssignmentContext(trx) {
  const [roleDefs, branches] = await Promise.all([
    accessRepository.loadRoleDefinitions(trx),
    accessRepository.listActiveBranches(trx),
  ]);
  return { roleDefs, activeBranchIds: branches.map((b) => b.id) };
}

export async function createUser(auth, { username, fullName, password, role, branchIds, modules }) {
  if (!canManageRoles(auth.permissions, [role])) {
    throw forbidden('You are not allowed to create accounts with that role.');
  }

  const passwordHash = await hashPassword(password);
  try {
    const id = await db.transaction(async (trx) => {
      const { roleDefs, activeBranchIds } = await loadAssignmentContext(trx);
      const access = resolveAccessAssignment({
        actor: auth,
        roleDef: roleDefs[role],
        activeBranchIds,
        requestedBranchIds: branchIds,
        requestedModules: modules,
      });

      if (await userRepository.usernameExists(username, trx)) throw conflict(USERNAME_TAKEN);
      const newId = await userRepository.insert(trx, { username, fullName, passwordHash, createdBy: auth.user.id });
      await userRepository.setRoles(trx, newId, [role]);
      await accessRepository.setUserBranches(trx, newId, access.branchIds);
      await accessRepository.setUserModules(trx, newId, access.modules);
      await auditRepository.record(
        {
          actorUserId: auth.user.id,
          action: 'user.created',
          entityType: 'user',
          entityId: newId,
          details: { username, fullName, role, ...access },
        },
        trx,
      );
      return newId;
    });
    return userRepository.findById(id);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') throw conflict(USERNAME_TAKEN);
    throw error;
  }
}

/** Loads and locks a target user the caller is allowed to manage. */
async function loadManageableUser(trx, auth, id) {
  await userRepository.lockById(trx, id);
  const target = await userRepository.findById(id, trx);
  if (!target || !isVisibleTo(auth, target)) throw notFound('User not found.');
  if (!canManageRoles(auth.permissions, target.roles) || !hasBranches(auth, branchIdsOf(target))) {
    throw forbidden('You are not allowed to manage this account.');
  }
  return target;
}

export async function updateUser(auth, id, patch) {
  const isSelf = id === auth.user.id;

  await db.transaction(async (trx) => {
    const target = await loadManageableUser(trx, auth, id);
    const currentRole = target.roles[0];
    const nextRole = patch.role ?? currentRole;

    const roleChanging = patch.role !== undefined && !(target.roles.length === 1 && currentRole === patch.role);
    const deactivating = patch.isActive === false && target.isActive;
    const accessTouched = roleChanging || patch.branchIds !== undefined || patch.modules !== undefined;

    if (roleChanging && !canManageRoles(auth.permissions, [patch.role])) {
      throw forbidden('You are not allowed to assign that role.');
    }
    if (isSelf && (deactivating || accessTouched)) {
      throw forbidden('You cannot deactivate your own account or change your own role, branches or pages.');
    }
    if (target.roles.includes('superadmin') && target.isActive && (roleChanging || deactivating)) {
      const activeSuperadmins = await userRepository.lockActiveIdsWithRole(trx, 'superadmin');
      if (activeSuperadmins.length <= 1) {
        throw conflict('At least one active Superadmin account must remain.');
      }
    }

    const changes = {};
    if (patch.fullName !== undefined && patch.fullName !== target.fullName) {
      changes.fullName = { from: target.fullName, to: patch.fullName };
    }
    if (patch.isActive !== undefined && patch.isActive !== target.isActive) {
      changes.isActive = { from: target.isActive, to: patch.isActive };
    }
    if (roleChanging) changes.roles = { from: target.roles, to: [patch.role] };

    let access = null;
    if (accessTouched) {
      const { roleDefs, activeBranchIds } = await loadAssignmentContext(trx);
      const currentBranchIds = branchIdsOf(target);
      access = resolveAccessAssignment({
        actor: auth,
        roleDef: roleDefs[nextRole],
        activeBranchIds,
        requestedBranchIds: patch.branchIds ?? currentBranchIds,
        currentModules: target.modules,
        // Explicit requests are validated as-is; carried-over pages are pruned to what the
        // (possibly new) role supports and the caller can grant.
        requestedModules:
          patch.modules ??
          target.modules.filter((code) => grantableModules(auth, roleDefs[nextRole]).includes(code)),
      });
      if (!sameList(access.branchIds, currentBranchIds)) {
        changes.branchIds = { from: currentBranchIds, to: access.branchIds };
      }
      if (!sameList(access.modules, [...target.modules].sort())) {
        changes.modules = { from: target.modules, to: access.modules };
      }
    }

    if (Object.keys(changes).length === 0) return;

    await userRepository.update(trx, id, { fullName: patch.fullName, isActive: patch.isActive });
    if (roleChanging) await userRepository.setRoles(trx, id, [patch.role]);
    if (changes.branchIds) await accessRepository.setUserBranches(trx, id, access.branchIds);
    if (changes.modules) await accessRepository.setUserModules(trx, id, access.modules);
    // Access is re-read on every request; revoking still forces a fresh sign-in after a demotion.
    if (roleChanging || deactivating) await sessionRepository.revokeAllForUser(trx, id);

    await auditRepository.record(
      { actorUserId: auth.user.id, action: 'user.updated', entityType: 'user', entityId: id, details: changes },
      trx,
    );
  });

  return userRepository.findById(id);
}

/** Sets a new password for another user and signs them out everywhere. */
export async function resetPassword(auth, id, { password }) {
  if (id === auth.user.id) {
    throw forbidden('Use "Change password" to update your own password.');
  }

  const passwordHash = await hashPassword(password);
  await db.transaction(async (trx) => {
    await loadManageableUser(trx, auth, id);
    await userRepository.update(trx, id, { passwordHash });
    await sessionRepository.revokeAllForUser(trx, id);
    await auditRepository.record(
      { actorUserId: auth.user.id, action: 'user.password_reset', entityType: 'user', entityId: id },
      trx,
    );
  });
}

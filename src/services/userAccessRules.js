import { hasBranches } from '../config/permissions.js';
import { badRequest, forbidden } from '../utils/errors.js';

/** Modules of `roleDef` that `actor` may grant or remove. */
export function grantableModules(actor, roleDef) {
  if (roleDef.allModules) return [];
  const roleModules = roleDef.modules.map((m) => m.code);
  if (actor.modules === null) return roleModules;
  const own = new Set(actor.modules);
  return roleModules.filter((code) => own.has(code));
}

/**
 * Validates the branches and modules `actor` wants a user with role `roleDef` to have.
 *
 * - Roles with all-branch access get no branch rows; others need at least one branch,
 *   and the actor may only assign branches they have themselves.
 * - Roles with all-module access get no module rows; others may only receive modules
 *   their role supports and the actor can grant. Modules the actor cannot grant are
 *   kept as they are (`currentModules`), so an edit never silently removes them.
 *
 * @returns {{ branchIds: number[], modules: string[] }}
 */
export function resolveAccessAssignment({
  actor,
  roleDef,
  activeBranchIds,
  requestedBranchIds,
  currentModules = [],
  requestedModules,
}) {
  let branchIds = [];
  if (!roleDef.allBranches) {
    if (requestedBranchIds.length === 0) {
      throw badRequest('Select at least one branch.', [{ path: 'branchIds', message: 'Select at least one branch.' }]);
    }
    const active = new Set(activeBranchIds);
    if (requestedBranchIds.some((id) => !active.has(id))) {
      throw badRequest('Unknown or inactive branch.', [{ path: 'branchIds', message: 'Unknown or inactive branch.' }]);
    }
    if (!hasBranches(actor, requestedBranchIds)) {
      throw forbidden('You can only assign branches you have access to.');
    }
    branchIds = [...requestedBranchIds].sort((a, b) => a - b);
  }

  let modules = [];
  if (!roleDef.allModules) {
    const supported = new Set(roleDef.modules.map((m) => m.code));
    const grantable = new Set(grantableModules(actor, roleDef));

    const unsupported = requestedModules.filter((code) => !supported.has(code));
    if (unsupported.length) {
      const message = `Not available for the ${roleDef.name} role: ${unsupported.join(', ')}.`;
      throw badRequest(message, [{ path: 'modules', message }]);
    }
    if (requestedModules.some((code) => !grantable.has(code))) {
      throw forbidden('You can only grant pages you have access to.');
    }

    const kept = currentModules.filter((code) => supported.has(code) && !grantable.has(code));
    modules = [...new Set([...kept, ...requestedModules])].sort();
  }

  return { branchIds, modules };
}

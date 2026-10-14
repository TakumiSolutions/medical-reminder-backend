import * as userService from '../services/userService.js';

export async function list(req, res) {
  res.json(await userService.listUsers(req.auth, req.validatedQuery));
}

export async function get(req, res) {
  res.json({ user: await userService.getUser(req.auth, req.params.id) });
}

export async function create(req, res) {
  res.status(201).json({ user: await userService.createUser(req.auth, req.body) });
}

export async function update(req, res) {
  res.json({ user: await userService.updateUser(req.auth, req.params.id, req.body) });
}

export async function resetPassword(req, res) {
  await userService.resetPassword(req.auth, req.params.id, req.body);
  res.status(204).end();
}

/** Roles, branches and pages the caller may assign when creating or editing users. */
export async function formOptions(req, res) {
  res.json(await userService.getFormOptions(req.auth));
}

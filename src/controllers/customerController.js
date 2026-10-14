import * as customerService from '../services/customerService.js';

export async function list(req, res) {
  res.json(await customerService.listCustomers(req.auth, req.validatedQuery));
}

export async function get(req, res) {
  res.json({ customer: await customerService.getCustomer(req.auth, req.params.id) });
}

/** 201 for a new customer; 200 when the mobile number matched an existing one. */
export async function create(req, res) {
  const { customer, existed } = await customerService.createCustomer(req.auth, req.body);
  res.status(existed ? 200 : 201).json({ customer, existed });
}

export async function update(req, res) {
  res.json({ customer: await customerService.updateCustomer(req.auth, req.params.id, req.body) });
}

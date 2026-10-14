// HTTP-level checks that are rejected before any database access.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { db } from '../src/db/knex.js';

const app = createApp();
const ORIGIN = 'http://localhost:5173';

after(() => db.destroy());

describe('API guards', () => {
  it('requires a session for protected endpoints', async () => {
    for (const path of [
      '/api/auth/me',
      '/api/users',
      '/api/users/form-options',
      '/api/branches',
      '/api/audit-logs',
      '/api/customers',
      '/api/contact-imports',
    ]) {
      const res = await request(app).get(path);
      assert.equal(res.status, 401, path);
      assert.equal(res.body.error.code, 'UNAUTHORIZED');
    }
  });

  it('rejects state-changing requests from a foreign origin', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ username: 'a', password: 'b' });
    assert.equal(res.status, 403);
  });

  it('validates the login body', async () => {
    const res = await request(app).post('/api/auth/login').set('Origin', ORIGIN).send({ username: '' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'BAD_REQUEST');
    assert.ok(Array.isArray(res.body.error.details));
  });

  it('reports malformed JSON as a client error', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .set('Content-Type', 'application/json')
      .send('{"username":');
    assert.equal(res.status, 400);
  });

  it('returns JSON 404 for unknown endpoints', async () => {
    const res = await request(app).get('/api/does-not-exist');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });
});

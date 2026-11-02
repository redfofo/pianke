import assert from 'node:assert/strict';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { createApp } from './index.js';

/** Existing provider/config tests exercise their routes through a real admin login. */
export async function createAuthenticatedApp() {
  const previousPassword = process.env.ADMIN_PASSWORD;
  const previousUsername = process.env.ADMIN_USERNAME;
  process.env.ADMIN_PASSWORD = 'test-admin-password';
  process.env.ADMIN_USERNAME = 'admin';
  let app: FastifyInstance;
  try { app = await createApp(); }
  finally {
    if (previousPassword === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = previousPassword;
    if (previousUsername === undefined) delete process.env.ADMIN_USERNAME; else process.env.ADMIN_USERNAME = previousUsername;
  }
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'test-admin-password' } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  return {
    inject(input: string | InjectOptions) {
      const options = typeof input === 'string' ? { url: input } : input;
      return app.inject({ ...options, headers: { cookie, ...options.headers } });
    },
    close: () => app.close(),
  };
}

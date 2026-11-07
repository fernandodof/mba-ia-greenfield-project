import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { DataSource } from 'typeorm';
import { User } from '../../src/users/entities/user.entity';

export interface AuthenticatedUser {
  userId: string;
  email: string;
  accessToken: string;
}

const DEFAULT_PASSWORD = 'password123';

/**
 * Registers a user through `POST /auth/register` (which also creates the
 * user's channel), confirms the email directly in the DB, then logs in
 * through `POST /auth/login`. Auth routes are rate limited (10 req/min), so
 * callers clear the throttler storage in `beforeEach`.
 */
export async function createAuthenticatedUser(
  app: INestApplication<App>,
  dataSource: DataSource,
  email: string,
  password = DEFAULT_PASSWORD,
): Promise<AuthenticatedUser> {
  const server = app.getHttpServer();

  const registered = await request(server)
    .post('/auth/register')
    .send({ email, password })
    .expect(201);
  const { id: userId } = registered.body as { id: string };

  await dataSource
    .getRepository(User)
    .update({ id: userId }, { is_confirmed: true });

  const login = await request(server)
    .post('/auth/login')
    .send({ email, password })
    .expect(200);
  const { access_token: accessToken } = login.body as { access_token: string };

  return { userId, email, accessToken };
}

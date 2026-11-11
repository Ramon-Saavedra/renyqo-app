import request, { type Response } from 'supertest';

type ServerTarget = Parameters<typeof request>[0];
export type E2eAgent = ReturnType<typeof request.agent>;

/** Supertest agent: required so session/grant establishment sees persisted `user_sessions` rows. */
export function e2eAgent(server: ServerTarget): E2eAgent {
  return request.agent(server);
}

export async function registerWithAgent(
  server: ServerTarget,
  payload: Record<string, unknown>,
  expectedStatus = 201,
): Promise<{ agent: E2eAgent; response: Response }> {
  const agent = e2eAgent(server);
  const response = await agent
    .post('/api/v1/auth/register')
    .send(payload)
    .expect(expectedStatus);
  return { agent, response };
}

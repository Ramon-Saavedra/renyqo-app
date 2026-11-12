import { expect } from '@jest/globals';

/** Matches production SessionInfrastructureService cookie flags for the active NODE_ENV. */
export function expectSessionAuthSetCookie(cookies: unknown): void {
  const expectations = [
    expect.stringMatching(/^sid=s(?:%3A|:)/),
    expect.stringMatching(/; HttpOnly(?:;|$)/),
    expect.stringMatching(/; SameSite=Lax(?:;|$)/),
  ];
  if (process.env['NODE_ENV'] === 'production') {
    expectations.splice(1, 0, expect.stringMatching(/; Secure(?:;|$)/));
  }
  expect(cookies).toEqual(expect.arrayContaining(expectations));
}

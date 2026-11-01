import type { Request } from 'express';
import { SessionSerializer } from './session.serializer';
import { UsersService } from '../../users/users.service';
import type { SafeUser } from '../../users/types/safe-user.type';

describe('SessionSerializer authentication versions', () => {
  const req = { sessionID: 'actual-sid' } as Request;
  const user = { id: 'user', authVersion: 2 } as SafeUser;
  const findByAuthenticatedSession = jest.fn();
  let serializer: SessionSerializer;
  beforeEach(() => {
    findByAuthenticatedSession.mockReset().mockResolvedValue(user);
    serializer = new SessionSerializer({
      findByAuthenticatedSession,
    } as unknown as UsersService);
  });
  it('serializes the credential snapshot rather than fetching a later version', () => {
    const done = jest.fn();
    serializer.serializeUser(user, done);
    expect(done).toHaveBeenCalledWith(null, { id: 'user', authVersion: 2 });
    expect(findByAuthenticatedSession).not.toHaveBeenCalled();
  });
  it('authenticates matching current durable state with one user read', async () => {
    const done = jest.fn();
    await serializer.deserializeUser(req, { id: 'user', authVersion: 2 }, done);
    expect(done).toHaveBeenCalledWith(null, user);
    expect(findByAuthenticatedSession).toHaveBeenCalledTimes(1);
    expect(findByAuthenticatedSession).toHaveBeenCalledWith(
      'user',
      'actual-sid',
      2,
    );
  });
  it('rejects an obsolete version', async () => {
    const done = jest.fn();
    await serializer.deserializeUser(req, { id: 'user', authVersion: 1 }, done);
    expect(done).toHaveBeenCalledWith(null, null);
  });
  it('rejects a missing grant/user match without creating one', async () => {
    findByAuthenticatedSession.mockResolvedValue(null);
    const done = jest.fn();
    await serializer.deserializeUser(
      req,
      { id: 'user', authVersion: 2, sid: 'untrusted-sid' },
      done,
    );
    expect(done).toHaveBeenCalledWith(null, null);
    expect(findByAuthenticatedSession).toHaveBeenCalledWith(
      'user',
      'actual-sid',
      2,
    );
  });
  it.each([
    'user',
    null,
    { id: 'user' },
    { id: 'user', authVersion: '2' },
    { id: 'user', authVersion: 0 },
    { id: 'user', authVersion: 1.5 },
    { id: 'user', authVersion: -1 },
    { id: 'user', authVersion: 2147483648 },
  ])('rejects missing/invalid snapshots: %j', async (snapshot) => {
    const done = jest.fn();
    await serializer.deserializeUser(req, snapshot, done);
    expect(done).toHaveBeenCalledWith(null, null);
    expect(findByAuthenticatedSession).not.toHaveBeenCalled();
  });
  it('refuses to establish a session without server version metadata', () => {
    const done = jest.fn();
    serializer.serializeUser({ id: 'user' } as SafeUser, done);
    expect(done).toHaveBeenCalledWith(expect.any(Error));
  });
  it('propagates current-user lookup errors', async () => {
    findByAuthenticatedSession.mockRejectedValue(
      new Error('database unavailable'),
    );
    const done = jest.fn();
    await serializer.deserializeUser(req, { id: 'user', authVersion: 2 }, done);
    expect(done).toHaveBeenCalledWith(expect.any(Error), null);
  });
});

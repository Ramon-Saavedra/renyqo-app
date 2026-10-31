import { SessionSerializer } from './session.serializer';
import { UsersService } from '../../users/users.service';
import type { SafeUser } from '../../users/types/safe-user.type';

describe('SessionSerializer authentication versions', () => {
  const user = { id: 'user', authVersion: 2 } as SafeUser;
  const findById = jest.fn();
  let serializer: SessionSerializer;
  beforeEach(() => {
    findById.mockReset().mockResolvedValue(user);
    serializer = new SessionSerializer({ findById } as unknown as UsersService);
  });
  it('serializes the credential snapshot rather than fetching a later version', () => {
    const done = jest.fn();
    serializer.serializeUser(user, done);
    expect(done).toHaveBeenCalledWith(null, { id: 'user', authVersion: 2 });
    expect(findById).not.toHaveBeenCalled();
  });
  it('authenticates matching current durable state with one user read', async () => {
    const done = jest.fn();
    await serializer.deserializeUser({ id: 'user', authVersion: 2 }, done);
    expect(done).toHaveBeenCalledWith(null, user);
    expect(findById).toHaveBeenCalledTimes(1);
  });
  it('rejects an obsolete version', async () => {
    const done = jest.fn();
    await serializer.deserializeUser({ id: 'user', authVersion: 1 }, done);
    expect(done).toHaveBeenCalledWith(null, null);
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
    await serializer.deserializeUser(snapshot, done);
    expect(done).toHaveBeenCalledWith(null, null);
    expect(findById).not.toHaveBeenCalled();
  });
  it('refuses to establish a session without server version metadata', () => {
    const done = jest.fn();
    serializer.serializeUser({ id: 'user' } as SafeUser, done);
    expect(done).toHaveBeenCalledWith(expect.any(Error));
  });
  it('propagates current-user lookup errors', async () => {
    findById.mockRejectedValue(new Error('database unavailable'));
    const done = jest.fn();
    await serializer.deserializeUser({ id: 'user', authVersion: 2 }, done);
    expect(done).toHaveBeenCalledWith(expect.any(Error), null);
  });
});

import type { Request } from 'express';
import type { SafeUser } from '../src/users/types/safe-user.type';
import type {
  SessionAuthority,
  AuthorizationContext,
} from '../src/provider-authorization/domain/authorization.types';
import type { ProviderActor } from '../src/provider-authorization/provider-listing-access';

export const UNIT_WORKSPACE_ID = '00000000-0000-4000-8000-000000000090';
export const UNIT_MEMBERSHIP_ID = '00000000-0000-4000-8000-000000000091';
export function unitSession(userId: string): SessionAuthority {
  return {
    mode: 'SESSION_BOUND',
    userId,
    authVersion: 1,
    sessionId: 'unit-session',
  };
}
export function unitProvider(userId: string): ProviderActor {
  return { authority: unitSession(userId), workspaceId: UNIT_WORKSPACE_ID };
}
export function unitActor(
  userId: string,
  side: string,
): ProviderActor | SessionAuthority {
  return side.toUpperCase() === 'PROVIDER'
    ? unitProvider(userId)
    : unitSession(userId);
}
export function unitContext(
  userId: string,
  role: 'OWNER' | 'AGENT' = 'OWNER',
): AuthorizationContext {
  return {
    mode: 'SESSION_BOUND',
    userId,
    authVersion: 1,
    sessionId: 'unit-session',
    workspaceId: UNIT_WORKSPACE_ID,
    membershipId: UNIT_MEMBERSHIP_ID,
    role,
    status: 'ACTIVE',
    membershipRevision: 1,
    workspaceLifecycle: 'ACTIVE',
    ownershipRevision: 1,
  };
}
export function unitRequest(
  user: SafeUser | null,
  workspaceId = UNIT_WORKSPACE_ID,
): Request {
  return {
    user: user ? { ...user, authVersion: user.authVersion ?? 1 } : undefined,
    sessionID: 'unit-session',
    isAuthenticated: () => user !== null,
    header: (name: string) =>
      name.toLowerCase() === 'x-workspace-id' ? workspaceId : undefined,
  } as unknown as Request;
}

// Explicit seam fixture for pure domain unit tests. These callbacks do not
// claim to test authorization; restricted-login PostgreSQL suites do that.
export function unitProviderOperations<T>(
  tx: T,
  transact?: <R>(produce: (tx: T) => Promise<R>) => Promise<R>,
) {
  function execute<R>(
    ...args: [
      ProviderActor,
      string,
      string | undefined,
      (tx: T, context: AuthorizationContext) => Promise<R>,
    ]
  ) {
    return args[3](tx, unitContext(args[0].authority.userId));
  }
  function mutate<R>(...args: Parameters<typeof execute<R>>) {
    return transact
      ? transact((client) =>
          args[3](client, unitContext(args[0].authority.userId)),
        )
      : execute(...args);
  }
  function mutateApplication<R>(
    ...args: [
      ProviderActor,
      string,
      string,
      (tx: T, id: string, context: AuthorizationContext) => Promise<R>,
    ]
  ) {
    const produce = (client: T) =>
      args[3](client, args[2], unitContext(args[0].authority.userId));
    return transact ? transact(produce) : produce(tx);
  }
  return { read: execute, mutate, mutateApplication };
}
export function unitApplicantOperations<T>(
  tx: T,
  transact?: <R>(produce: (tx: T) => Promise<R>) => Promise<R>,
) {
  async function readApplication<R>(
    ...args: [
      SessionAuthority,
      string,
      (tx: T, id: string) => Promise<void>,
      (tx: T, id: string) => Promise<R>,
    ]
  ) {
    await args[2](tx, args[1]);
    return args[3](tx, args[1]);
  }
  function mutate<R>(...args: Parameters<typeof readApplication<R>>) {
    return transact
      ? transact(async (client) => {
          await args[2](client, args[1]);
          return args[3](client, args[1]);
        })
      : readApplication(...args);
  }
  return {
    assertPrincipal: () => Promise.resolve(),
    readApplication,
    mutateApplication: mutate,
    admit: mutate,
  };
}

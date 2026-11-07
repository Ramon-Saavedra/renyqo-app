import type {
  Prisma,
  WorkspaceLifecycle,
  WorkspaceMembershipRole,
} from '../../generated/prisma/client';

export type ActionScope = Readonly<{
  action: string;
  resourceIds: readonly string[];
}>;
export type SessionAuthority = Readonly<{
  mode: 'SESSION_BOUND';
  userId: string;
  authVersion: number;
  sessionId: string;
}>;
export type DelegatedAuthority = Readonly<{
  mode: 'USER_DELEGATED';
  userId: string;
  authVersion: number;
  workspaceId: string;
  membershipId: string;
  membershipRevision: number;
  ownershipRevision?: number;
  scope: ActionScope;
}>;
export type HumanAuthority = SessionAuthority | DelegatedAuthority;

// A contract for a later, purpose-specific system adapter, never a substitute
// accepted by the human request/transaction coordinators.
export type SystemAuthority = Readonly<{
  mode: 'SYSTEM';
  purpose: string;
  workspaceId: string;
  scope: ActionScope;
}>;
export interface SystemAuthorityPolicy {
  readonly purpose: string;
  authorize(
    tx: Prisma.TransactionClient,
    authority: SystemAuthority,
  ): Promise<void>;
}

export type AuthorizationRequirement = ActionScope &
  Readonly<{
    workspaceId: string;
    purpose: 'OPERATIONAL' | 'HISTORY' | 'SECURITY' | 'CLOSURE_SETTLEMENT';
    requiredRole?: 'OWNER';
    expectedMembershipId?: string;
    expectedMembershipRevision?: number;
    expectedOwnershipRevision?: number;
  }>;

export type AuthorizationContext = Readonly<{
  mode: HumanAuthority['mode'];
  userId: string;
  authVersion: number;
  sessionId?: string;
  workspaceId: string;
  membershipId: string;
  role: WorkspaceMembershipRole;
  status: 'ACTIVE';
  membershipRevision: number;
  workspaceLifecycle: WorkspaceLifecycle;
  ownershipRevision?: number;
}>;

export type AuthorityLockPlan =
  | Readonly<{ kind: 'BUSINESS' }>
  | Readonly<{
      kind: 'STRUCTURAL';
      expectedOwnershipRevision: number;
      membershipIds: readonly string[];
    }>;

// A policy must throw on denial. There is intentionally no default allow policy
// or permission/capability catalog in the foundation.
export type WritePolicy = (
  context: AuthorizationContext,
  tx: Prisma.TransactionClient,
  requirement: AuthorizationRequirement,
) => Promise<void>;
export type ReadPolicy = (
  context: AuthorizationContext,
  requirement: AuthorizationRequirement,
) => Promise<void>;

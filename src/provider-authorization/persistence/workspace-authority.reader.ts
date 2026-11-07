import { Injectable } from '@nestjs/common';
import type {
  Prisma,
  WorkspaceLifecycle,
  WorkspaceMembershipRole,
  WorkspaceMembershipStatus,
} from '../../generated/prisma/client';
import type { HumanAuthority } from '../domain/authorization.types';

export type WorkspaceAuthoritySnapshot = {
  userStatus: string;
  authVersion: number;
  sessionValid: boolean;
  membershipId: string | null;
  role: WorkspaceMembershipRole | null;
  status: WorkspaceMembershipStatus | null;
  revision: number | null;
  lifecycle: WorkspaceLifecycle | null;
  ownershipRevision: number | null;
};

@Injectable()
export class WorkspaceAuthorityReader {
  async read(
    db: Prisma.TransactionClient,
    authority: HumanAuthority,
    workspaceId: string,
  ) {
    const sid = authority.mode === 'SESSION_BOUND' ? authority.sessionId : '';
    // One primary statement: identity/session and tenant facts share a snapshot.
    // No replica, cached grant, or long-lived locking read transaction.
    const [row] = await db.$queryRaw<WorkspaceAuthoritySnapshot[]>`
      SELECT u.status::text AS "userStatus",u.auth_version AS "authVersion",
        (${authority.mode === 'USER_DELEGATED'} OR EXISTS (
          SELECT 1 FROM session_auth_grants g JOIN user_sessions s ON s.sid=g.sid
          WHERE g.sid=${sid} AND g.user_id=u.id AND g.auth_version=u.auth_version
            AND s.expire > clock_timestamp() AND s.sess->'passport'->'user'->>'id'=u.id::text
            AND jsonb_typeof(s.sess::jsonb->'passport'->'user'->'authVersion')='number'
            AND s.sess::jsonb->'passport'->'user'->'authVersion'=to_jsonb(u.auth_version)
        )) AS "sessionValid",
        m.id AS "membershipId",m.role::text AS role,m.status::text AS status,m.revision,
        w.lifecycle_status::text AS lifecycle,w.ownership_revision AS "ownershipRevision"
      FROM users u LEFT JOIN workspace_memberships m ON m.user_id=u.id AND m.workspace_id=${workspaceId}::uuid
      LEFT JOIN provider_workspaces w ON w.id=m.workspace_id WHERE u.id=${authority.userId}::uuid`;
    return row ?? null;
  }
}

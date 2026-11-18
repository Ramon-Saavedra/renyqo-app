# Workspace invitations and account email verification

Phase 4.5.8 adds backend-only ORGANIZATION team admission. Invitation
administration is structurally OWNER-only; AGENT capabilities cannot grant it.
No frontend, invitation-based authentication, ownership transfer, reinstatement,
editable capability grants or general audit ledger is activated.

## Identity and links

Registration/login/password recovery and invitation issuance share canonical
email normalization: trim and lowercase, without provider-specific aliases.
The identity migration locks writes, refuses existing canonical collisions and
never merges accounts. Resolve collisions explicitly before deployment.

An authenticated account must independently verify its current email before
inspection/acceptance. Auth challenges bind user, canonical email, authVersion
and originating session; they expire and are single-use. Changing email clears
verification and consumes outstanding challenges. An invitation never verifies
email, creates credentials, selects a password or authenticates its recipient.
Existing and new users use normal login/registration, verification, then acceptance.

Both links contain independent 256-bit opaque secrets, domain-separated SHA-256
hashes in storage, and fixed configured frontend paths. Secrets travel in URL
fragments, never OWNER responses, sessions, command evidence or backend logs.
Future frontend consumers must keep fragments out of analytics and exchange them
only through the authenticated JSON endpoints with normal CSRF protection.

## Lifecycle and capacity

PENDING transitions to ACCEPTED, REVOKED or EXPIRED; terminal records cannot reopen
or be physically deleted. One PENDING record per workspace/canonical email is
enforced without a time-dependent index predicate. Expired pending records have
effective EXPIRED status immediately; reissue/revoke materializes expiry and
release under the workspace root lock. Expired reservations already stop counting.

Create reserves capacity atomically. Resend keeps the invitation/reservation and
expiry, rotates the hash, advances generation/revision and invalidates the old
secret. Revoke/expire release once. Acceptance releases the reservation before
inserting its membership in the same Serializable transaction. Current plan and
usage are rechecked, including the occupied reservation: a full reserved final
seat can exchange, but OVER_LIMIT or unassigned cannot admit a new member.

New AGENT INSERTs require deferred, matching accepted invitation evidence, and
ordinary runtime DML cannot forge acceptance. Existing memberships are grandfathered;
ACTIVE membership can be consumed redundantly without changes; SUSPENDED/REMOVED
cannot be resumed, reinstated or duplicated. Colors/history remain durable.

## Authority, RLS and locking

Invitations bind the creating OWNER membership revision, global authVersion and
workspace ownershipRevision. Ordinary issuer logout does not invalidate them;
relevant issuer/security/designation changes require reissue. Lifecycle and expiry
are checked against authoritative database state.

The non-login NOBYPASSRLS invariant role owns bounded SECURITY DEFINER helpers
with fixed search paths and no PUBLIC EXECUTE. Both invitation/evidence tables
have ENABLE/FORCE RLS. Bootstrap requires server-derived authenticated verified
identity, live durable session grant and computed token hash, and returns only
the matching invitation's routing identifiers. Temporary bootstrap settings are
cleared; normal ACTIVE-member bootstrap is unchanged.

The closed acceptance coordinator permits no arbitrary prospective-member callback.
It revalidates within the existing transaction protocol: sorted invitee/issuer
User SHARE locks, session grant SHARE, workspace root, sorted memberships,
reservation, invitation, evidence. Locks live until outer commit. Serializable
conflicts use the existing bounded transaction retry mechanism; tokens/IDs are
allocated outside retries and no network operation occurs inside the transaction.

Creation/resend/revoke command receipts bind actor, kind and canonical input;
changed-input reuse conflicts. Acceptance replay rechecks current account/session,
workspace and ACTIVE canonical membership, returning no additional seat/membership.

## Delivery and operational controls

SES configuration must exist before new issuance. Invitation/reservation/hash
commit first; SES receives the plaintext only in memory afterwards. Transport
failure retains PENDING state and reports FAILED. Recovery is explicit resend
with a new secret, never recoverable ciphertext or retry of the old link.
ACCEPTED delivery means SES accepted the request, not guaranteed inbox delivery.
A crash between commit/send/record can leave UNKNOWN; generation-conditional
delivery recording cannot overwrite a newer issuance. No general outbox is added.

| Configuration | Default | Bounds (seconds) |
| --- | --- | --- |
| INVITATION_TTL_SECONDS | 86400 | 60–604800 |
| EMAIL_VERIFICATION_TTL_SECONDS | 1800 | 60–86400 |
| INVITATION_RESEND_COOLDOWN_SECONDS | 60 | 0–3600 |
| EMAIL_VERIFICATION_COOLDOWN_SECONDS | 60 | 0–3600 |

Verification issuance and resend cooldowns are serialized by User/root locks,
respectively. Focused attempt throttling is bounded in-memory (30/minute per
IP/actor/path, maximum 10000 buckets), timer-free and per process. Multi-replica
deployments must retain edge-level aggregate abuse controls; this is not a
distributed rate-limit platform. Tests explicitly set cooldowns to zero.

## HTTP contract

All paths are under `/api/v1`, use existing session/CSRF protection and accept no
client-selected authority. OWNER endpoints require `x-workspace-id`.

| Method/path | Input / response |
| --- | --- |
| GET /provider/team | page/limit; safe paginated members/invitations, capacity, actions |
| POST /provider/workspace-invitations | email, commandId; safe invitation metadata |
| POST /provider/workspace-invitations/:id/resend | revision, commandId |
| POST /provider/workspace-invitations/:id/revoke | revision, commandId |
| POST /workspace-invitations/inspect | token; minimal matching workspace/invitation state |
| POST /workspace-invitations/accept | token, commandId; minimal canonical membership |
| POST /auth/email-verification/request | authenticated account; truthful delivery outcome |
| POST /auth/email-verification/confirm | token; verified result |

Missing/foreign/wrong-email/revoked tokens use the same unavailable response.
Unverified account is 409; stale/ineligible admission is 409; unavailable token
is 404; invalid verification proof is 400; throttling is 429; missing SES config
is 503. Unexpected SQL failures are not generically suppressed.
Team responses omit hashes, passwords, sessions and security epochs. Dormant
membership actions remain false. Resource responsibility never grants authority.

## Deployment and validation

Apply `20261117100000_invitation_identity_schema`,
`20261117101000_invitation_lifecycle_guards`,
`20261117102000_invitation_bootstrap`, `20261117103000_invitation_admission`,
and `20261117104000_email_verification_guards` with the separate migrator.
Re-run application-runtime provisioning before starting the updated API/worker.
Startup now verifies invitation RLS, evidence immutability privileges and helper
EXECUTE grants as well as the existing role graph. Never substitute a superuser.

Focused specs are `provider-invitations-*.e2e-spec.ts` and
`email-verification.e2e-spec.ts`. Existing migration parity covers clean/upgrade
functions, policies, grants and constraints; schema drift compares Prisma shape.
HTTP suites use a physical restricted runtime login and captured SES transport,
with production-equivalent durable sessions and explicit schema/pool teardown.

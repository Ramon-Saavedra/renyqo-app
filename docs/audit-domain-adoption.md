# Audit — Phase 4.5.10 Slice 3 mutation coverage

This matrix describes current executable paths, not proposed product workflows.
Slice 1/2 and the locked Phase 4.5.10 architecture remain authoritative. Audit
does not replace domain history, receipts, authorization, quotas or outbox.

| Domain / command | Transaction / authority | Actor / resource | State / existing evidence | Audit / effect | Availability |
| --- | --- | --- | --- | --- | --- |
| Invite CREATE | ProtectedWorkspaceTransactions; OWNER | MEMBER / invitation | absent → PENDING; invitation command receipt | provider.invitation.created / action:resource | operational |
| Invite RESEND | same | MEMBER / invitation | PENDING generation/revision advances; command receipt | provider.invitation.resent / action:resource | operational |
| Invite REVOKE | same | MEMBER / invitation | PENDING → REVOKED, or EXPIRED after deadline; command receipt | provider.invitation.revoked or expired / action:resource | operational |
| Replace expired invite | same root transaction as CREATE | MEMBER / old invitation | PENDING → EXPIRED; EXPIRE receipt | provider.invitation.expired / action:resource | implicit operational transition |
| Invite ACCEPT | closed invitation admission transaction; verified session/email/token relationship | USER / invitation and new membership | PENDING → ACCEPTED; ACCEPT receipt and immutable member identity | provider.invitation.accepted + provider.membership.created / action:resource | operational; replay adds nothing |
| Member suspend/resume | caller-owned lifecycle persistence primitive | no authenticated orchestration | ACTIVE ↔ SUSPENDED; membership revision | not activated | internal dormant primitive, no controller/export |
| Member remove/reinstate / OWNER transfer | fail-closed commands | none | dependencies remain incomplete | none | dormant; MUST NOT activate here |
| Plan mock activation | protected OWNER structural transaction | MEMBER / workspace | previous/new plan version + revision; WorkspacePlanChange | provider.plan.assigned / action:resource | dev/test opt-in only |
| Internal plan assign | caller-owned persistence primitive | caller owns authority | immutable WorkspacePlanChange | adoption at authenticated mock adapter | no commercial/SYSTEM workflow exists |
| Listing creation initial assignment | protected listing-create transaction; capability + scope + quota | MEMBER / listing | none → responsible member; INITIAL assignment transition/receipt | provider.listing_assignment.changed / action:resource | operational |
| OWNER reassign | protected structural transaction; OWNER | MEMBER / listing | old → new responsible member; assignment transition | provider.listing_assignment.changed / action:resource | operational; no-op adds nothing |
| AGENT transfer request | protected structural transaction; responsible AGENT | MEMBER / request | absent → REQUESTED; request command identity | provider.listing_transfer.requested / action:resource | operational |
| Transfer approve/reject/cancel | protected structural transaction; OWNER or source cancellation | MEMBER / request | REQUESTED → decision; request evidence; approval also assignment transition | provider.listing_transfer.decided plus assignment.changed on approval | operational |
| Expire old transfer before new request | same root transaction | MEMBER / old request | REQUESTED → EXPIRED | provider.listing_transfer.expired / action:resource | implicit operational transition |

All rows use the already selected workspace and existing canonical lock order.
No current background/SYSTEM mutation exists in these adopted domains. Profile
revalidation does not mutate invitations, memberships, plans or assignments.
Workspace establishment/onboarding is still an internal unactivated foundation.
No new public audit endpoint or query visibility is introduced.

## Implementation contract

Required evidence is appended inside the existing outer transaction. Domain
receipts are checked before adoption; failures reject and roll back the mutation.
Payloads contain only explicit state/revision/immutable IDs, never invitation
email, token/hash, session identifiers, or arbitrary entity serialization.
Forward migrations are necessary because Slice 1/2 deliberately constrain the
catalog and append path to the single ledger activation action. Old migrations
must not be rewritten. Historical events are not backfilled.


## Atomic evidence references and deployment

Domain adapters submit only typed evidence references. Closed SQL extractors
construct action/version/resource/allowlisted changes from those canonical rows;
no caller-provided JSON payload or new domain authority is accepted. Runtime
cannot call the private extractors, read Audit tables or promote itself to SYSTEM.
The existing Slice 2 transaction context, completion fence and sanitized signals
are reused. Business timestamps come from canonical evidence, not delivery time.

Invitation receipts are persisted inside the existing closed admission helper
(and owner command transaction). Audit references that receipt before commit;
changing this internal order would require replacing the established admission
seam. Receipt, membership, reservation and Audit still commit or roll back
atomically. A receipt cannot be returned from an adopted command whose required
Audit failed. Assignment/plan histories remain their authoritative domain facts.

Replays and successful no-ops produce no new event. ALREADY_MEMBER acceptance
records acceptance only, not a fictitious membership creation. Delivery outcome
bookkeeping is operational mail telemetry, not another invitation lifecycle
transition. Entitlement projections and calculated OVER_LIMIT remain read-only.

Six forward migrations extend only constraints and closed helpers; no new table,
column, role or runtime table privilege is introduced. Apply them before the new
API/worker binary. Old migration files and historical ledger rows are unchanged.
Listing creation adopts only its initial assignment fact here; listing content,
publication, applications, documents and other Slice 4 adoption remain excluded.

Strict review covers payload allowlists, actor/target separation, receipt replay,
existing locks, historical identity, private function grants, pooled context and
rollback after persistence failure. Isolated E2E fault triggers are test-only and
are always removed; production guards/grants are never disabled.

## Changed file inventory

- `docs/audit-context.md`
- `docs/audit-domain-adoption.md`
- `prisma/migrations/20261121120000_audit_domain_catalog/migration.sql`
- `prisma/migrations/20261121121000_audit_domain_commands/migration.sql`
- `prisma/migrations/20261121122000_audit_invitation_evidence/migration.sql`
- `prisma/migrations/20261121123000_audit_portfolio_evidence/migration.sql`
- `prisma/migrations/20261121124000_audit_domain_append/migration.sql`
- `prisma/migrations/20261121125000_audit_invitation_admission/migration.sql`
- `src/audit/commands/audit-command.ts`
- `src/audit/context/domain-audit.ts`
- `src/audit/context/required-audit.spec.ts`
- `src/audit/context/required-audit.ts`
- `src/audit/domain/audit-action.ts`
- `src/audit/domain/domain-action.ts`
- `src/audit/domain/domain-evidence.spec.ts`
- `src/audit/domain/domain-evidence.ts`
- `src/audit/persistence/audit-runtime-verifier.ts`
- `src/listing-assignments/agent-transfer-requests.ts`
- `src/listing-assignments/assignment-audit.ts`
- `src/listing-assignments/owner-reassignment.ts`
- `src/listing-assignments/transfer-response.ts`
- `src/listings/listing-creation.ts`
- `src/provider-authorization/invitation-acceptance.transaction.ts`
- `src/provider-entitlements/adapters/mock-plan-activation.ts`
- `src/provider-entitlements/assignments/plan-audit.ts`
- `src/provider-invitations/commands/invitation-audit.ts`
- `src/provider-invitations/commands/owner-invitations.ts`
- `src/provider-invitations/domain/invitation-lifecycle.ts`
- `test/audit-domain-admission.e2e-spec.ts`
- `test/audit-domain-failure.fixture.ts`
- `test/audit-domain-invitations.e2e-spec.ts`
- `test/audit-domain-migration.e2e-spec.ts`
- `test/audit-domain-portfolio.e2e-spec.ts`
- `test/audit-migrations.fixture.ts`
- `test/e2e-suite-hooks.ts`
- `test/listing-workspace.fixture.ts`
- `test/workspace-entitlements-http.e2e-spec.ts`

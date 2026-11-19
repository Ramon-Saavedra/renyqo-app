# Member color and durable actor identity — Phase 4.5.9

## Canonical identity and color

WorkspaceMembership remains the durable identity: UUID, workspaceId and userId
are immutable, workspace/user is unique, and physical deletion remains forbidden.
Role, status, name, email and color never identify or authorize a member.

The existing `display_color` column is now a closed canonical identifier
(`varchar(32)` plus a database CHECK), represented by the typed MemberColor catalog.
There is no second current-color field/table, global User color or session color.
Team now returns `colorId` rather than a raw hex `color`; its existing `id` is
retained alongside `membershipId`. No frontend consumer is implemented here.

Colors are immutable after membership creation. ACTIVE and SUSPENDED count toward
current color usage. REMOVED retains its historical color but stops counting.
There is deliberately no color UNIQUE index: distinctness is an admission
preference, with deterministic reuse, rather than a lifetime membership cap.
Future reinstatement preserves the original member/color even when it collides
with a replacement. It cannot recolor another member or create a new identity.
Removal/reinstatement and ownership-transfer commands remain dormant.

## Selection and invitations

OWNER may supply optional `requestedColorId` on invitation creation. Only catalog
IDs are accepted; CSS, HTML and raw hex are rejected. The intent is immutable and
survives resend. It is not a reserved color or an authoritative membership color.
Revocation/expiry changes no membership presentation.

At INSERT, PostgreSQL selects under the existing Serializable workspace-root
protocol: use a currently unused requested color; otherwise choose an unused
color in catalog order; after exhaustion choose the least-used color, with the
same order breaking ties. No randomness, retry loop or recoloring is involved.
The first OWNER is inserted into its newly created, transaction-owned parent;
established workspaces must have the existing root baseline before admission.
Seat exchange and invitation admission proof remain unchanged. Redundant ACTIVE
acceptance never changes the member's color. AUTO/occupied selections cannot
bypass seat limits, lifecycle rules or current authority.

`GET /api/v1/provider/team/member-colors` is structurally OWNER-only and returns
`colors[{id,currentUsageCount,currentlyUnused,recommended}]`,
`assignmentPolicy=UNUSED_THEN_LEAST_USED` and `canRecolor=false`.
Usage excludes REMOVED; a color is not described as unavailable. Availability is
advisory until acceptance. There is no recolor endpoint or capability grant.

## Reviewed rendering contract

The catalog has 17 vivid fill colors with separate high-contrast light/dark ink
variants. Filled chips use the stated black/white label. Values below are rendering
recommendations, not arbitrary styles accepted or persisted from clients.

Measured light surfaces: `#edebe1`, `#f1ead6`, `#faf5e7`, `#fffdf7`.
Measured dark surfaces: `#0c0c0e`, `#151518`, `#17171a`.
These are the current Renyqo frontend theme values. Ink ratios are the minimum
across those surfaces; fill ratios are label versus fill. Tests enforce >=4.5:1.

| ID / stable order | Fill | Label | Fill contrast | Light ink min | Dark ink min |
| --- | --- | --- | ---: | ---: | ---: |
| ROYAL_BLUE | #2455E6 | WHITE | 5.97 | 5.58 | 5.04 |
| BURGUNDY | #98002E | WHITE | 8.84 | 7.36 | 5.36 |
| DARK_PURPLE | #6200A3 | WHITE | 10.25 | 8.53 | 5.81 |
| STRONG_VIOLET | #7C2BEB | WHITE | 6.17 | 5.91 | 5.99 |
| PETROL_BLUE | #006071 | WHITE | 7.21 | 6.93 | 8.37 |
| STRONG_CYAN | #00B8D9 | BLACK | 8.86 | 5.70 | 10.08 |
| TURQUOISE | #00A68A | BLACK | 6.82 | 5.60 | 9.67 |
| EMERALD_GREEN | #008A50 | BLACK | 4.75 | 5.51 | 9.12 |
| STRONG_GREEN | #268A10 | BLACK | 4.73 | 5.65 | 9.74 |
| LIME_GREEN | #A0C900 | BLACK | 10.85 | 5.62 | 12.19 |
| INDUSTRIAL_YELLOW | #FFCC00 | BLACK | 13.89 | 5.74 | 11.83 |
| STRONG_ORANGE | #F26600 | BLACK | 6.68 | 5.75 | 7.64 |
| STRONG_RED | #D92323 | WHITE | 4.98 | 5.39 | 5.63 |
| FUCHSIA | #B800BC | WHITE | 5.58 | 6.04 | 5.75 |
| MAGENTA | #CF0069 | WHITE | 5.44 | 5.99 | 5.48 |
| COPPER | #AD551A | WHITE | 5.13 | 6.38 | 7.62 |
| INDIGO | #4030B8 | WHITE | 9.00 | 7.49 | 5.54 |

Color always accompanies textual identity. Contrast alone does not prove that
every pair is perceptually distinguishable, including color-vision deficiencies.
Filled chips on other surfaces, including dark inputs, need the reviewed on-fill
label and a contrasting neutral outline where the fill boundary fails 3:1.
Do not reuse ink variants on untested surfaces. Frontend visual/accessibility
review remains required before UI implementation; no screen was changed.

## Historical actor snapshots

The small shared V1 contract contains actorUserId, actorMembershipId,
actorWorkspaceId, actorRoleAtTime, actorDisplayNameAtTime, actorColorAtTime,
snapshotVersion and capturedAt. Names are plain text, never HTML instructions.
No email, avatar URL, credential, session, authVersion, capability or security epoch
is copied. A snapshot is evidence, never an authorization context.

ProtectedWorkspaceTransactions captures the canonical actor before domain policy/
mutation, after the existing User/session/root/member fences. The observation is
transaction-local, xid-tagged presentation bookkeeping, not an authentication
session or a new security epoch. Commit/rollback clears it. Domain evidence
triggers populate snapshots from selected-tenant membership/User facts; supplied
JSON cannot replace them. A changed-role observation must have the existing
ownership baseline provenance. No new ownership pointer or snapshot table exists.

The selected-tenant builder is SECURITY INVOKER. Private evidence adapters use the
existing non-login NOBYPASSRLS invariant role, fixed search_path and revoked PUBLIC
EXECUTE. They route only through the evidence's parent resource and do not install
another tenant context or expose a global member directory.

Snapshots are added to listing_events, application_activities,
verification_decisions, listing_criteria_revisions, viewing_command_receipts,
workspace_plan_changes, workspace_invitation_commands, listing_assignment_transitions
and listing_transfer_requests. Transfer requests retain separate creation and
decision actor snapshots. Approved assignment evidence attributes the action to
the approver, not the assigned member or original transfer requester. Participants
retain their existing references; they must not be rendered as historical names
using current profile joins.

Captured snapshot and actor/resource binding cannot be overwritten. Legacy NULL
snapshots are never backfilled from current names/roles/colors. Recognized provider
evidence captures only within its selected tenant; applicant/system facts do not
gain a provider-member identity. The internal activity timeline/preview projects
CAPTURED or LEGACY_UNSNAPSHOTTED explicitly. Applicant projections omit snapshots
and internal member identifiers. Existing WAITING/resource-scope checks remain.

This prepares existing evidence for 4.5.10, not an AuditEvent ledger. Existing
tables retain their domain/retention rules; it is not a blanket RLS or append-only
cutover. Controlled pseudonymization/retention belongs to the approved later audit
phase. Do not add generic admin snapshot rewriting in this phase.

## Migration and deployment

Six forward migrations are shipped; earlier migrations are unchanged:

1. `20261119100000_member_color_catalog`: explicit preflight, closed catalog and
   approved normalization exception. Known legacy mappings: #2563EB → ROYAL_BLUE,
   #7C3AED → STRONG_VIOLET, #123456/#112233 → PETROL_BLUE, #654321 → COPPER,
   #DB2777 → MAGENTA, #000000 → DARK_PURPLE. Unknown values abort for explicit
   mapping review; no nearest-color algorithm or silent reset is used.
2. `20261119101000_member_color_admission`: root-locked deterministic INSERT
   selection and immutable invitation color intent.
3. `20261119102000_invitation_color_admission`: forward replacement of the narrow
   admission function to consume requested color intent; existing seat proof stays.
4. `20261119103000_member_actor_snapshots`: nullable legacy snapshot columns and
   selected-tenant snapshot helpers.
5. `20261119104000_member_actor_evidence`: focused evidence capture/immutability
   adapters and minimum invariant-role application routing-column grants.
6. `20261119105000_member_actor_legacy_provenance`: explicitly legacy criteria
   baselines/verification facts remain unsnapshotted rather than acquiring a
   present-day identity. This correction is forward-only.

The migration orders non-REMOVED members by created_at,id per workspace, assigns
catalog order cyclically, and maps REMOVED historical colors intentionally. This
repairs the old shared-blue state under the approved exception without changing
UUIDs, user/workspace links, status, role, timestamps or security revisions.
It holds parent/table DDL locks and temporarily disables only the immutable-color
UPDATE guard in that transaction. Deferred constraints are checked per workspace
before reenabling the guard; rollback also restores DDL state. RLS is never disabled.

This is a coordinated schema cutover: quiesce the old API/workers before applying
the migrations, then start the new binaries. Do not run a legacy hex-writing
binary against the normalized schema. The parent/table DDL locks require this
quiescent deployment window; no business lifecycle transition or data reset is
used to obtain it.

Apply all migrations before starting the new API/worker; startup checks the
snapshot helper/column privileges as part of the existing restricted-runtime gate.
No superuser fallback or broader runtime table grants are added.

## Validation and deferred work

Focused specs: member-presentation-*.e2e-spec.ts and member-actor-*.e2e-spec.ts.
They exercise actual restricted PostgreSQL logins, HTTP projections, observed lock
waits without sleeps, exhaustion, removal/reinstatement foundation compatibility,
actor/participant distinction, before-role-change capture, profile edits, legacy
absence, raw SQL tampering, backfill and preflight rollback. Existing parity/drift,
invitation/seat, authorization and full regressions remain required.

Frontend Team/actor chips, fixing legacy “Du” provider labels, message sender/read
attribution (4.5.11), realtime and the audit ledger (4.5.10) remain deferred. No
ownership-transfer/removal/reinstatement endpoint or permission UI is activated.

# Plans and capacity — Phase 4.5.7

Capabilities decide what an actor can do; listing responsibility decides where;
entitlements decide what the workspace can acquire. Existing User/session,
membership, lifecycle, scope and RLS checks remain mandatory.

## Catalog and assignment

Published `PlanVersion` rows are immutable. The deployment publishes only
`PERSONAL_FREE` version 1 (one listing, one seat, no commercial features).
Organization limits and feature packages have not been approved: organizations
backfill as unassigned, never implicitly paid. Organization versions must be
explicitly approved and published by a reviewed forward migration before use.
Test catalogs exist only under `test/`; they are not production offers.

Each workspace has one `WorkspacePlanAssignment`, including explicit unassigned
state. Its database-derived revision is an administrative concurrency precondition,
not an authentication epoch. Assignment changes and durable change evidence commit
together. This evidence does not implement the Phase 4.5.10 audit ledger.

PERSONAL establishment assigns the free version. Conversion preserves workspace,
membership and allocation evidence and changes the assignment to unassigned
ORGANIZATION. It does not activate a plan or free another PERSONAL allocation.

## Capacity and locking

All non-RETIRED listings count, including DRAFT, PAUSED and RENTED. Retirement is
irreversible and releases a slot by changing canonical status; no cached counter is
maintained. A relisted campaign is a new DRAFT with an immutable same-workspace
retired predecessor. Applications/documents/history are never reparented.

Seats count ACTIVE/SUSPENDED memberships (OWNER once) plus unreleased reservations
whose expiry is later than database time. Removal releases occupancy, suspension
does not. The internal reservation primitive owns capacity only; invitation tokens,
emails, acceptance and account activation remain Phase 4.5.8.

Acquisitions require the existing Serializable workspace-root protocol:
sorted Users FOR SHARE → session grant → structural workspace write → sorted
memberships → command/assignment/reservation dependencies → listings → evidence.
Protected retries rerun authorization and capacity checks. Runtime-role raw SQL
and multi-row writes are checked by database guards, using full-workspace counts
under the selected-tenant invariant role, independently of AGENT listing scope.

PERSONAL has at most one non-RETIRED listing, exactly one non-REMOVED accepted
membership and no team reservation, regardless of plan configuration.

Voluntary downgrade requires both dimensions to fit, including valid reservations.
Forced downgrade preserves data and derives OVER_LIMIT. New acquisitions are
blocked; reductions and existing authorized operations remain available. No listing
is hidden/unpublished and no membership suspended automatically. Unassigned state
allows no growth. PAST_DUE/GRACE/BILLING_RESTRICTED policy remains reserved and
inactive; no payment automation or detailed delinquency matrix is implemented.

## HTTP contract

`POST /api/v1/provider/listings` requires a UUID `commandId`, plus normal draft
fields. Optional `responsibleMembershipId` remains constrained by OWNER/AGENT
rules; `predecessorListingId` requires existing authorized retired-history access.
Creation-only fields are rejected on PATCH. Initial multipart media is rejected;
upload media through the existing protected media endpoint after creation.

Same command/input replays the current authorized listing without acquiring a
second slot. Changed input conflicts. Replay is denied after revocation or loss of
listing scope. Initial assignment evidence binds the actor, input fingerprint,
responsible member, listing and command. Failed transactions leave no partial rows.

OWNER-only `GET /api/v1/provider/workspace-entitlements` returns plan/version,
assignment revision, listing/seat usage and limits, remaining capacity, excess
dimensions and action availability. It contains no payment information. Projections
are advisory: protected commands always check current authoritative state.

`POST /api/v1/provider/workspace-entitlements/mock-activation` requires authenticated
OWNER, development/test environment and `ENABLE_MOCK_PLAN_ACTIVATION=true`.
It accepts approved organization plan version, command and expected assignment/
ownership revisions. It records MOCK_DEV, never a payment or invoice. Production
always refuses this route. No generic plan administration endpoint exists.

Named capacity failures map narrowly to 409: LISTING_LIMIT_REACHED,
SEAT_LIMIT_REACHED, WORKSPACE_OVER_LIMIT, PLAN_UNAVAILABLE, DOWNGRADE_BLOCKED,
PLAN_REVISION_CONFLICT and CREATION_COMMAND_CONFLICT. Future unentitled features
use 403 FEATURE_NOT_ENTITLED. Foreign/inaccessible resources retain existing errors.

## Deployment and validation

Apply the five forward `2026111610*` migrations with deployment credentials. They
preflight PERSONAL listing excess without resetting data, backfill assignments,
install FORCE RLS and minimum runtime grants, then enable guards and lineage.
Backfill and new-workspace assignment initialization commit together under a
workspace-root table lock. Keep administrative workspace conversion and capacity
writes quiescent through the migration chain; deploy/provision before API/worker
cutover. The migration credential must have full RLS visibility; runtime must not.
Provisioning/startup verification includes the new entitlement boundary. Runtime
cannot publish/change plan versions or write assignment history directly.

Fresh/upgrade parity and Prisma drift tests cover the new tables. Restricted-login
capacity and HTTP suites exercise acquisition races, rollback, immutable terms,
forced downgrade, scope/capability separation and protected replay. Existing
membership removal/reinstatement/ownership execution remains dormant.

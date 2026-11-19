# Provider workspace frontend-readiness contracts

These read-only projections expose presentation and advisory operation availability.
They do not establish authority, reserve capacity, implement onboarding or activate
dormant membership/ownership workflows.

## Discovery

`GET /api/v1/provider/workspaces` returns only the authenticated user's ACTIVE
memberships in ACTIVE workspaces. Each item contains `workspaceId`, `membershipId`,
`role`, `kind` and canonical `displayName`. A candidate workspace header does not
change discovery. Zero results do not trigger workspace creation.

Apply the forward `20261119120000_workspace_discovery_presentation` migration
before deploying this API. It recreates the existing function transactionally to
extend its return shape, preserving the non-login NOBYPASSRLS owner, trusted
search path, restricted EXECUTE and self-discovery policies. Only SELECT on the
existing display-name column is added. No Prisma model or data backfill changes.

## Selected workspace

`GET /api/v1/provider/workspaces/current` requires the ordinary session and
`x-workspace-id` bootstrap. It returns exactly:

- `workspace`: `id`, `displayName`, `kind`;
- `membership`: current `id`, `role`, `colorId`;
- `actions.createListing`: `allowed`, `reason`.

The global user name remains in SafeUser. Workspace display identity comes from
ProviderWorkspace, never User.companyName, OWNER name or OrganizationProfile.
The endpoint uses OPERATIONAL authority: suspended/removed memberships are
unavailable and CLOSING/CLOSED workspaces deny this operation. No internal
authorization context, revisions, other members or administrative capacity is
returned. Responses are private/no-store and vary by Cookie and workspace header.
Missing, malformed, foreign and nonexistent workspace selections retain the
existing safe errors. Switching workspaces means a new request/transaction.

## Creation availability

The canonical `listing.create` requirements are evaluated first. Missing
capability produces `{ allowed: false, reason: 'NOT_PERMITTED' }`. Account,
session, membership or workspace-lifecycle denial rejects the request through
the existing authorization boundary, rather than returning an unauthorized shell.

The existing tenant-wide entitlement resolver and acquisition policy determine
growth availability. Unassigned plan, full listing capacity or any OVER_LIMIT
dimension produce `{ allowed: false, reason: 'WORKSPACE_GROWTH_UNAVAILABLE' }`.
Success is `{ allowed: true, reason: null }`. OWNER and AGENT receive the same
minimal action shape; OWNER retains the separate administrative entitlement API.
Unexpected errors propagate instead of becoming an availability denial.

Counts include all retained workspace listings, even those outside AGENT
responsibility. PERSONAL structural limits remain enforced by canonical capacity
logic. The query writes no reservation or command evidence. It describes ordinary
creation with default responsibility, not validity of arbitrary creation inputs,
assignment targets or relisting lineage. Concurrent growth can invalidate it;
the actual command reauthorizes and enforces capacity under existing locks.

## Validation and boundaries

Focused tests: `current-workspace.e2e-spec.ts`, `workspace-discovery.e2e-spec.ts`
and `listing-creation-availability.spec.ts`. Migration parity covers clean and
upgrade replay including function ownership, policies and grants.

Team, invitation/verification, actor history, responsible-member projections,
assignment/transfer queries, billing, commercial plans and frontend remain outside
this slice. No new permission epoch, security helper or tenant policy is added.

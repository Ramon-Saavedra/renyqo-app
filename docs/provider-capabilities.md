# Provider capability model — Phase 4.5.6

This compatibility step adds typed provider operations and capabilities to the
existing authorization boundary. It adds no migration, persisted grants, scope
fields, security epochs, permission editor or financial endpoint.

## Sources and reconciled decisions

Primary source: [Phase 4.5](https://app.notion.com/p/410db9f6b97d8166aafcdee1f0afa3d2),
especially 4.5.0, 4.5.2, 4.5.3 and 4.5.6. Related decisions are in the
[Architecture Roadmap](https://app.notion.com/p/409db9f6b97d81e5afc6facae84b3bd4)
and [Listing Akta inventory](https://app.notion.com/p/40fdb9f6b97d81e4b3faf9eeaf05ccee).

- The implementation request narrows the first delivery to role-derived defaults.
  Custom grants and their persistence remain later work.
- Notion requires an optional `financial.read` contract. Ramon's explicit
  clarification adds typed `FINANCIAL_READ` as reserved only: it is absent from
  both roles' effective defaults and from every runtime operation requirement.
  Financial/billing access retains existing OWNER-only structural rules until
  separately approved delegation activation. Public asking rent/deposit editing
  remains operational Listing management.
- Older references to ARCHIVED or an "active OWNER" do not supersede the locked
  RETIRED lifecycle or exactly one designated OWNER, including suspension.
- Notion's unchecked 4.5.5 checklist is older than the implemented Listing cutover.
  Keep immutable workspace ownership, responsibility evidence, restricted runtime,
  RLS and the merged attention/overview scope-revalidation fixes.
- Media operations use Listing READ/MANAGE capabilities; verification metadata
  uses DOCUMENT_READ. No unsupported reporting module or separate media role is
  invented. Complete operational reports use explicit combined READ requirements.
- Frontend inspection is allowed; no UI change is required for unchanged wire
  contracts and compatibility defaults. Any later frontend work follows Notion's
  architecture/UI review workflow. No permission-management UI is introduced.

## Catalog and defaults

Canonical catalog: `provider-authorization/capabilities/provider-capability.ts`.

| Domain                    | Capabilities                                                            |
| ------------------------- | ----------------------------------------------------------------------- |
| Listings/media            | LISTING_READ, LISTING_MANAGE, LISTING_CREATE                            |
| Applications              | APPLICATION_READ, APPLICATION_MANAGE                                    |
| Viewings                  | VIEWING_READ, VIEWING_MANAGE                                            |
| Documents                 | DOCUMENT_READ, DOCUMENT_CONTENT_READ, DOCUMENT_REQUEST, DOCUMENT_REVIEW |
| Verification              | VERIFICATION_MANAGE                                                     |
| Conversations             | CONVERSATION_READ, CONVERSATION_MANAGE                                  |
| Assignment requests       | LISTING_TRANSFER_REQUEST                                                |
| Reserved finance contract | FINANCIAL_READ                                                          |

ACTIVE AGENT receives the current normal operational set, constrained to existing
responsible-listing scope. ACTIVE OWNER receives the operational set except the
AGENT-only transfer request/cancellation capability. Neither receives reserved
FINANCIAL_READ. SUSPENDED/REMOVED memberships have no effective authority.

Capabilities never expand scope. Phase 4.5.7 integrates creation with the
[canonical quota boundary](provider-entitlements.md). Membership removal/reinstatement and ownership transfer remain
dormant. This phase does not activate invitations, billing or team fan-out.
Defaults are explicit compatibility lists; adding a catalog entry never
automatically grants it to either role.

AI listing extraction remains outside this cutover. Its existing ProviderOnlyGuard
is product-entry compatibility, not workspace/capability authority. LISTING_CREATE
does not authorize it. A future integration must define its own workspace/action
contract; this phase does not claim that legacy path is workspace-revocation safe.

## Operations and enforcement

`operations/provider-operation.ts` defines closed identifiers independently from
capability names. Domain requirement modules map every identifier to explicit
allOf requirements; the aggregate is checked exhaustively by TypeScript and tests.
Unknown operations/capabilities and mismatched operation/action bindings deny.

| Operations                                   | Required capability family                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Listing detail/media read                    | LISTING_READ                                                                                                        |
| Listing list with application counts         | LISTING_READ + APPLICATION_READ                                                                                     |
| Listing edit/lifecycle/media mutation        | LISTING_READ + LISTING_MANAGE                                                                                       |
| Listing creation                             | LISTING_READ + LISTING_CREATE, plus existing entitlement gate                                                       |
| Application read/count/activity              | APPLICATION_READ                                                                                                    |
| Application reject/restore/promotion         | APPLICATION_READ + APPLICATION_MANAGE                                                                               |
| Document/verification metadata               | APPLICATION_READ + DOCUMENT_READ                                                                                    |
| Content download                             | Metadata requirements + DOCUMENT_CONTENT_READ                                                                       |
| Request/cancel/replace                       | Metadata requirements + DOCUMENT_REQUEST                                                                            |
| File acknowledgement                         | Metadata requirements + DOCUMENT_REVIEW                                                                             |
| Verification decision/subject administration | Metadata requirements + VERIFICATION_MANAGE                                                                         |
| Viewing read/workflow history                | APPLICATION_READ + VIEWING_READ                                                                                     |
| Viewing/workflow mutation                    | Viewing read requirements + VIEWING_MANAGE                                                                          |
| Conversation read/read acknowledgement       | APPLICATION_READ + CONVERSATION_READ                                                                                |
| Send/reply administration                    | Conversation read requirements + CONVERSATION_MANAGE                                                                |
| Attention/workspace/overview composites      | All relevant application/document/viewing/conversation READ capabilities; Listing headers also require LISTING_READ |

The exact operation map is the typed source, not inference from HTTP verbs or URL
prefixes. Domain services supply explicit operation identity through
ApplicationListingAccess instead of generic application.read/write labels.

ProviderListingAccess installs the operation requirement. The existing resolver
evaluates it after authoritative global/membership/lifecycle resolution, before
protected resource production. The write coordinator re-resolves under its existing
locks before mutation and receipt replay. Fresh read scopes re-evaluate capabilities
as well as membership/resource scope. Sensitive content reads retain their final
availability/authority check. USER_DELEGATED action/resource binding is preserved.

Viewing consideration additionally requires APPLICATION_MANAGE because its
DO_NOT_CONTINUE branch invokes application rejection. Its action projection and
command use the same combined requirement.

Low-level authorization foundation policies remain usable for their explicitly
reviewed purposes; a generic action string alone grants no capability. All covered
provider operational adapters install the typed provider operation requirement.

## Structural and projection boundaries

Exactly-one-OWNER, OWNER designation/suspension, lifecycle, tenancy, PERSONAL
cardinality, assignment evidence and revision rules remain structural. OWNER
ordering/reassignment/approval/rejection keep their existing explicit guards;
their empty capability allOf sets do not confer these powers on AGENT.
AGENT request/cancellation additionally retain source identity and eligibility.

Composite endpoints require every protected section's READ capabilities and never
silently omit sections. Domain-owned action projectors apply capability AND
existing eligibility to booleans and viewing action records after scope checks.
They visit explicit DTO children only, preserve prototypes, and never rewrite
message bodies or historical activity payloads. Counts describe domain state;
an action flag is not an independent authority token. Commands always reauthorize.
WAITING stays anonymous; historical visibility and 404 contracts remain unchanged.

The existing frontend consumes canReview/canDownload/canRestore/canPropose and
conversation/workflow action flags. No raw grant snapshot or new frontend type is
required. Backend flags remain the UI contract; frontend checks cannot authorize.

## Later persisted allowlists

Persisted AGENT allowlists need a separate forward migration and OWNER-controlled
change workflow. Database-derived membership.revision must advance for semantic
grant/scope changes; no second capability epoch is permitted. Future changes must
coordinate defaults, demotion reset, audit, entitlement/assignment dependencies,
field-sensitive financial delegation and permission-management UI. No such command
or persistence is implemented by this compatibility step.

## Validation

Policy tests exhaustively cover allOf requirements, unknown values, metadata/content
separation, file review versus verification, reserved finance and action projections.
Restricted-runtime HTTP tests use real authentication and PostgreSQL. Test-only
server policy substitution exercises future restricted sets without persisting
grants or mocking authentication, membership, RLS, domain guards or locks.
Revocation tests exercise the existing membership epoch and both lock orders;
actual persisted capability mutations cannot be tested before that later model exists.

Focused E2E: `npm run test:e2e -- --runTestsByPath test/provider-capabilities-http.e2e-spec.ts test/provider-capabilities-revocation.e2e-spec.ts test/attention-scope-revalidation.e2e-spec.ts test/overview-scope-revalidation.e2e-spec.ts --detectOpenHandles`.

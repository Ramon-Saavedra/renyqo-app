# Audit ledger — Phase 4.5.10, Slice 2

This slice adds opt-in execution infrastructure only. AppModule still does not
import AuditModule; no domain endpoint/worker produces audit automatically. Only
the foundation activation action is registered. Slice 3 requires separate approval.

## Explicit execution, not ambient authority

AuditedWorkspaceTransactions delegates to ProtectedWorkspaceTransactions with the
same authority resolution, retries and lock plan. It adds only an audit completion
fence. Domain code must authorize and replay existing receipts before binding an
AuditContexts execution, mutate inside that same outer transaction, and append
the declared effects. Audit creates no independent transaction or savepoint.

AuditContexts.member receives the coordinator's authenticated context, never a
request DTO. SQL independently checks the selected tenant, global account epoch,
session when SESSION_BOUND, and current member/revision. USER_DELEGATED membership
execution is restricted to the trusted internal adapter boundary; the human
runtime cannot select it to bypass its session. That seam retains the originating
user/epoch without requiring a browser grant. The existing coordinator enforces
its action/resource scope. No delegated-job runtime is activated here.

The SQL fence follows User → grant → workspace → membership. These exact actor
locks are already held by the coordinator; it adds no target User after root locks.
Actor names/role/color are captured before business mutation under those fences.
Current role changes never rewrite historical presentation or become a second
ownership source. No authVersion, session ID or capability snapshot is persisted.

USER execution is separate: use the existing ApplicantListingAccess transaction
and wrap its callback with auditedWork. An owned Application establishes its tenant;
the audit helper checks that relationship again. There is no arbitrary USER +
workspace selector. USER snapshot presentation stays private and is not exposed by
the OWNER audit reader, preserving applicant anonymity boundaries.

SYSTEM requires a closed purpose, exact scope and an explicit policy. Its opener
is available only to trusted invariant execution, never the human runtime. There
is no human-to-system fallback, public system bypass or new background-job engine.
INTEGRATION remains reserved and denied.

## Context, identity and command lifetime

Private audit_execution_contexts binds commandId/scope, required effect keys,
correlation/causation, server actor facts and a pre-mutation snapshot to the current
top-level xid. It does not select a tenant: every operation asserts the existing
current_workspace_id(). No new tenant GUC or global mutable application context exists.

The private bookkeeping RLS policy is xid-bound so the transaction-end constraint
can detect an unclosed context even if local tenant settings were cleared. Runtime
has no direct table access. Contexts must be deleted by successful completion;
an unclosed context rejects commit. Rollback removes them naturally. No execution
bookkeeping survives a successful commit. Deferred audit appends are unsupported:
all declared effects must be recorded before closing the execution.

The immutable audit_actor_identities sidecar is inserted only on the first effect;
its reference is shared by the command's effects. Slice 1 rows keep a null identity
reference; no historical presentation is fabricated. Privacy erasure and legal hold
are not implemented or activated. The ledger core remains append-only.

Required effect keys are explicit, unique and bounded (1–32). Audit does not replace
receipts or promise exactly-once HTTP execution. A repeated effect conflicts. A
legitimate domain receipt replay occurs before binding and appends nothing new.
Different effects under one command are supported. Invalid/missing evidence fails
the transaction; invalid payloads never become entity/HTTP/exception dumps.

auditedWork is mandatory at the outer adopted callback boundary. PostgreSQL can
respond ROLLBACK to COMMIT on an already aborted transaction without an exception
from the adapter. The final SQL fence makes swallowed errors reject the operation,
not merely roll back its data. Legacy non-adopted callers remain unchanged.

## Queries and observability

AuditQuery is an internal SESSION_BOUND OWNER reader, with fresh authorization for
each page and final membership-revision revalidation after composition. No AGENT,
Applicant, implicit Support/Admin, endpoint, export or generic dump is added.
SQL independently verifies session/OWNER and selected tenant. Raw runtime access
to ledger, identity and execution tables stays denied. Pages use recordedAt,id
descending and limits 1–100; concurrent pagination is not a snapshot/export or a
global commit-order guarantee. Legacy rows may have no captured actor presentation.

AuditSignals emits only closed structured signals: AUDIT_CONTEXT_MISSING,
AUDIT_ACTOR_INVALID, AUDIT_PAYLOAD_REJECTED, AUDIT_APPEND_FAILED and AUDIT_QUERY_DENIED.
No names, credential/session data, payloads or raw SQL exceptions are logged.
Operational signals are not canonical audit evidence.

## Special paths and deployment

Workspace creation has no accepted member yet; invitation acceptance has its own
closed admission transaction. Neither is automatically adapted here. A later
domain-specific adapter must bind the authenticated actor at the correct stage.
Profile revalidation remains its approved multi-workspace exception and cannot
switch ordinary audit tenant scopes. It needs a separate bounded adoption adapter.
Existing workers, suspension/removal and ownership-transfer paths are unchanged;
dormant workflows do not become active merely because audit infrastructure exists.

Five additive migrations add storage, command/lifetime constraints, closed human/
system context openers, controlled append/completion and bounded OWNER queries.
The invariant role is reused with minimum helper privileges; no runtime table grant
or owner/BYPASSRLS membership is added. All helpers have trusted search paths and
PUBLIC EXECUTE revoked. Apply migrations before the new API/worker binary; old
binaries remain compatible and no business table requires audit yet.

Validation includes complete unit regression, focused context/identity/rollback/
query/migration specs, Slice 1, restricted runtime and existing revocation/RLS
regressions, plus fresh/upgrade replay, parity/drift and normal static/build gates.

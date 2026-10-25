# Viewing and lifecycle realtime invalidation (Phase 7)

> This page records its implementation phase. Phases 1–9 are complete; see [current rollout and schema](viewing-workflow-rollout.md) for deployment status and follow-ups.

HTTP read models remain authoritative. Socket.IO delivers hints on the existing authenticated `domain-event` channel; clients cannot publish domain events. No replay, state recovery protocol, notification inbox or second socket transport is introduced.

## Contract

Application events have no `conversationId`. Example viewing event:

```json
{
  "eventId": "10000000-0000-4000-8000-000000000001",
  "type": "application.viewing.changed",
  "schemaVersion": 1,
  "occurredAt": "2026-10-24T12:00:00.000Z",
  "applicationId": "10000000-0000-4000-8000-000000000002",
  "payload": {
    "listingId": "10000000-0000-4000-8000-000000000003",
    "workflowId": "10000000-0000-4000-8000-000000000004",
    "workflowRevision": 7
  }
}
```

`workflowId` and `workflowRevision` are optional; legacy mutations may omit them. Revision is a hint for refetch/coalescing, never a command result or client state projection. Lifecycle events use the same envelope with `type: application.lifecycle.changed` and **only** `listingId` in the payload. Neither type contains appointments, dates, messages, statuses, counts, profile/document fields or recipient IDs. Strict application payload validation rejects unknown fields and unsupported versions. Existing conversation event names, required conversation scope and wire payloads remain unchanged.

An application hidden from the current provider produces a redacted, server-derived hint for that provider:

```json
{
  "eventId": "10000000-0000-4000-8000-000000000001",
  "type": "listing.applications.changed",
  "schemaVersion": 1,
  "occurredAt": "2026-10-24T12:00:00.000Z",
  "listingId": "10000000-0000-4000-8000-000000000003",
  "payload": {}
}
```

It contains no application, applicant, conversation or workflow identifier. It is derived at delivery time, not stored as an additional outbox event. The applicant still receives their own application hint.

## Producers and atomicity

The existing transactional activity writer delegates all viewing and application lifecycle activity types to `ApplicationOutboxProducer`. This covers new and legacy commands, attendance, corrections, interest, provider consideration, no-show consequences, promotion, withdrawal, rejection and restore. Reconciliation emits when the workflow mode/revision actually changes. Listing status transitions and rental selection also invalidate every application belonging to the listing, including historical applications and applications without viewings.

Outbox writes use the domain transaction. Writer failure rolls back domain state, history, ordering and command receipts. There are no new domain locks or lock-order changes. One event of each type per application per transaction is coalesced using the PostgreSQL transaction ID, application ID and event type as a unique key. Multiple history records still remain separate. An exact command receipt replay makes no effective mutation and creates no additional event. A later independent transaction receives a new key. Outbox retries retain the event ID; duplicate and out-of-order delivery must be harmless invalidation.

The additive migration makes `conversation_id` nullable, adds a nullable unique deduplication key and enforces scope: the two application event types require null conversation scope; other existing event types require conversation scope. Existing rows and IDs remain unchanged. No fictitious conversation or historical events are backfilled.

## Authorization and privacy

Recipients are not persisted. Initial routing and a final lookup immediately before emission use current ownership, role and the existing application visibility policy. Existing session validation still runs for every eligible socket. All eligible connected tabs receive the appropriate event. Deleted aggregates or mismatched listing scope are dropped. Current providers receive full application hints for visible active/historical applications; WAITING and never-active hidden applications produce only the listing hint. Delayed events are redacted according to current access, even if access changed during session validation.

Rejecting/restoring never marks messages read, deletes unread state or changes stored reply settings. Existing HTTP policy determines effective chat/reply availability and unread relevance; lifecycle invalidation causes those reads to run again. Restored unread messages can therefore reappear.

No supported listing ownership-transfer command exists today. An out-of-band owner change routes only to the current owner; a future ownership-transfer/deletion feature must explicitly invalidate the former owner's listing collection without exposing application IDs. A database authorization check and socket emission cannot be globally atomic; HTTP authorization remains mandatory on every read/command and reconnect/focus refetch repairs missed hints.

## Frontend integration and recovery

Both application events invalidate application/workflow details, attention, applicant/provider cards, workspace, listing/application overviews and affected listing ACTIVE ordering. Lifecycle events additionally invalidate chat availability, reply capability and unread/topbar queries. A no-show changes the listing's ordering, so invalidating only the affected application's card is insufficient.

The redacted listing event must clear/revalidate listing-owned cached application details and collections, including previously open workspaces that now return 404. It must not rely on a hidden application identifier. Use authoritative deep-link targets returned by Phase 6 HTTP models; events are not navigation DTOs.

Clients must refetch on socket reconnect and window focus, coalesce bursts and tolerate duplicate/out-of-order events. An event does not prove a state or grant access. Offline clients may miss all hints. Outbox dispatch is not a per-user durable notification inbox: Phase 9 supplies the implemented durable inbox; its frontend integration remains a rollout requirement. Deadline processing is implemented separately in [Phase 8](viewing-workflow-expiry.md).

Listing changes with no applications have no application event; general listing-only realtime is separate listing-domain work. High-volume listing closure emits per application; monitor transaction duration and outbox backlog before increasing listing application limits.

## Deployment and API replica #2

For one API process, the existing database dispatcher, authenticated Socket.IO transport, local connection registry and final session/authorization checks work together. No Redis is added. Deploy the migration before the new producer and consumer; stop the old dispatcher while switching versions. Old consumers cannot process the new event types. A rollback must keep old dispatchers disabled while new events remain queued, or retain a compatible consumer. Realtime-disabled deployments still write domain outbox records.

**Before API replica #2**, implement shared cross-instance fanout integrated with outbox publication and per-instance eligible socket delivery, plus cross-instance session revocation/validation. Database `SKIP LOCKED` distributes outbox work but does not send a claimed event to sockets on other replicas. Sticky sessions alone are insufficient. Merely installing a Socket.IO adapter is also insufficient while delivery enumerates only the publisher process's local eligible sockets and emits directly to those socket objects. Define fanout acknowledgement/retry semantics and retain local final authorization/session checks on each receiving instance. Redis is one possible later transport; no choice is made here.

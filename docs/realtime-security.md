# Realtime transport security

The single API instance exposes one Socket.IO namespace, `/realtime`, using WebSocket transport at the default `/socket.io` path. The HTTP `/api/v1` prefix does not prefix this transport path. There is no frontend client in this slice.

The server emits only `domain-event` notifications. Clients cannot join rooms, send messages, acknowledge reads or execute other domain commands over sockets. Any application event sent by a client disconnects it. Only the server assigns `user:{userId}` rooms; application/listing rooms do not exist.

## Identity and validity

Socket admission requires the exact origin of `FRONTEND_URL` and a valid signed `sid` cookie. Missing origins, alternate origins and unsigned/tampered cookies fail closed. A joined PostgreSQL lookup resolves the stored Passport identity, session expiry, current role and active account. Client auth fields are ignored. The default namespace rejects connections.

HTTP session middleware and socket signature verification share the same session infrastructure and secret. Sockets never run session-saving/touching middleware, so connection/revalidation/heartbeats do not create or extend login sessions. Existing login session regeneration and HTTP CSRF protection remain unchanged.

All recipient sessions are checked again before delivery. HTTP logout and a successful password reset disconnect affected realtime sockets immediately (by session id or user id). A non-overlapping background sweep still disconnects other revoked idle sockets (deleted/expired sessions, suspended or deleted accounts) within the configured interval (default 15 seconds). Pre-delivery checks do not use a stale cache. Session IDs are deduplicated and checked with accounts in batches of 200, not once per socket. Role/identity changes require reconnecting. Lookup failure disconnects idle sockets and fails publication. Read-only checks have a five-second operation deadline.

## Privacy and delivery

The router verifies the exact application/conversation relationship and reuses the applications domain's provider visibility policy. Recipient lists are resolved again immediately before emit so provider visibility cannot drift between routing and delivery. Delayed events for current WAITING applications cannot be routed to providers, even if that provider previously had access. Terminal history remains readable when existing policy permits it. Reply disabling changes write capability, not read access.

Rooms identify users but do not bypass per-session validation: delivery emits to individually eligible connections, never blindly broadcasts to every session in a user room. No raw database rows are sent.

The allowlisted envelope contains `eventId`, `type`, `schemaVersion`, ISO `occurredAt`, `applicationId`, `conversationId`, and a minimal validated payload:

| Type                                    | Payload                                        |
| --------------------------------------- | ---------------------------------------------- |
| `conversation.message.created`          | `messageId`, `messageSequence`                 |
| `conversation.reply-permission.changed` | `enabled`                                      |
| `conversation.read.advanced`            | `readerSide`, `throughSequence`, `markedCount` |

Additional input payload fields are stripped. Unsupported versions/types and malformed required fields fail publication. No bodies, profiles, document content, cookie/session identifiers or storage metadata are logged or sent. Rejection logs use fixed signals; publisher errors are sanitized before the outbox records them.

## Recovery and failures

HTTP/database remain authoritative. There is no replay endpoint, socket history, client acknowledgement requirement or Socket.IO connection-state recovery. Reconnect requires fresh authentication. HTTP snapshots refresh capabilities/unread/receipts; chat catch-up uses `afterSequence`. A future client must resync on reconnect and focus, tolerate duplicate `eventId` values, and never overwrite current state from old invalidations.

No connected recipients is a successful publication. Gateway unavailability, shutdown, failed recipient/session lookup or a publication deadline cause outbox retries. Partial publication can duplicate an event. In-flight invalidations can be lost after local emission; durable domain data remains accessible through HTTP.

## Configuration and rollout

| Variable                                | Default |
| --------------------------------------- | ------- |
| `REALTIME_ENABLED`                      | `false` |
| `REALTIME_SESSION_RECHECK_INTERVAL_MS`  | `15000` |
| `REALTIME_MAX_CONNECTIONS_PER_SESSION`  | `5`     |
| `REALTIME_MAX_CONNECTIONS`              | `1000`  |
| `REALTIME_HANDSHAKES_PER_IP_PER_MINUTE` | `60`    |

An enabled transport requires explicit `FRONTEND_URL`. Dispatch enabled with transport disabled fails startup. Keep normal outbox lease defaults (30 seconds). Packets are limited to 4 KiB. Handshake counters use the direct peer IP, intentionally not untrusted forwarding headers; behind a proxy this limit aggregates that proxy's traffic and must be sized accordingly. Counter memory and connection admission are bounded.

Deploy disabled, validate staging with transport enabled, then enable dispatch. Enable production transport before dispatch and monitor the historical backlog, retry exhaustion and rejection rates. Rollback disables dispatch and transport without changing domain producers or deleting pending rows.

## Deployment boundary

Supported only for one API instance. Before replica two, introduce shared live fan-out and apply session/recipient authorization at the receiving replicas. A Socket.IO Redis adapter can carry live notifications but does not automatically distribute this implementation's local connection-registry filtering, nor provide durable browser delivery. No Redis, multi-instance support or additional domain producers are included here.

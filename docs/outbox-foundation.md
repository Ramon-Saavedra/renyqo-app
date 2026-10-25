# Transactional outbox foundation

This page records the conversation foundation. Application/listing invalidation and user-scoped notification hints are now implemented; see [viewing realtime](viewing-workflow-realtime.md), [notifications](viewing-workflow-notifications.md) and [current rollout](viewing-workflow-rollout.md). Conversation compatibility is preserved.

This phase persists **domain events in PostgreSQL** in the **same transaction** as conversation mutations. HTTP remains authoritative for commands, snapshots, histories, uploads, and read acknowledgements.

**Realtime delivery is not active by default.** Both `REALTIME_ENABLED` and `OUTBOX_DISPATCH_ENABLED` default to `false`. The real Socket.IO publisher is wired, but dispatch requires realtime to be enabled; contradictory configuration fails startup. Rows accumulate safely while dispatch is disabled. See [Realtime security](realtime-security.md).

## Event types (schema version 1)

| Type                                    | When                                                |
| --------------------------------------- | --------------------------------------------------- |
| `conversation.message.created`          | After a committed message (no body in payload)      |
| `conversation.reply-permission.changed` | Only on actual `applicantRepliesEnabled` transition |
| `conversation.read.advanced`            | Only when read ack updates at least one message     |

Dispatch is **at-least-once**. Consumers must deduplicate on `eventId` (outbox row id).

## Configuration

| Variable                      | Default | Meaning                                            |
| ----------------------------- | ------- | -------------------------------------------------- |
| `OUTBOX_DISPATCH_ENABLED`     | `false` | Poll and publish; requires `REALTIME_ENABLED=true` |
| `OUTBOX_POLL_INTERVAL_MS`     | `1000`  | Dispatcher interval when enabled                   |
| `OUTBOX_BATCH_SIZE`           | `50`    | Claim batch size                                   |
| `OUTBOX_LEASE_MS`             | `30000` | Claim lease duration                               |
| `OUTBOX_MAX_ATTEMPTS`         | `25`    | Publish attempts before quiescing a row            |
| `OUTBOX_RETENTION_DAYS`       | `7`     | Delete **dispatched** rows older than this         |
| `OUTBOX_RETENTION_BATCH_SIZE` | `500`   | Retention delete batch                             |

Pending and failed rows are never deleted by retention.

Publishing validates schema version 1 and builds an allowlisted envelope. The router resolves current ownership and provider visibility from the exact application/conversation pair. No recipients are persisted. Missing/deleted aggregates and offline recipients complete normally. Database, validation, transport readiness or delivery errors fail publication and retain retry behavior. Retries may repeat notifications with the same event ID. There is no global event ordering guarantee.

The publisher has a five-second operation deadline. Late lookups cannot emit after that deadline. A slow batch stops starting additional events after its lease expires; remaining claims recover through lease expiry. Shutdown stops scheduling and waits for the active poll. Exhausted rows remain pending with `next_attempt_at` set to 2099: monitor `OUTBOX_DISPATCH_EXHAUSTED`, repair the cause, and use an authorized operational database action to reschedule the affected IDs. Never blanket-mark them dispatched.

Dispatch success means local delivery handling completed, **not** that a browser acknowledged receipt. Socket events are invalidations, not a durable client inbox. Reconnect/focus recovery uses HTTP. Activation can drain a historical backlog; old permission/read metadata must trigger a current HTTP refresh rather than overwrite newer state.

## Multi-instance

Safe for a **single API instance** with one dispatcher loop. Multiple replicas require a shared realtime bus and coordinated dispatch before enabling delivery at scale.

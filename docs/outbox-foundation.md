# Transactional outbox foundation

This phase persists **domain events in PostgreSQL** in the **same transaction** as conversation mutations. HTTP remains authoritative for commands, snapshots, histories, uploads, and read acknowledgements.

**Realtime delivery is not active by default.** `OUTBOX_DISPATCH_ENABLED` defaults to `false`. In production, enabling dispatch without a transport publisher fails application startup. Rows accumulate safely until a later Socket.IO (or other) publisher is wired.

## Event types (schema version 1)

| Type | When |
|------|------|
| `conversation.message.created` | After a committed message (no body in payload) |
| `conversation.reply-permission.changed` | Only on actual `applicantRepliesEnabled` transition |
| `conversation.read.advanced` | Only when read ack updates at least one message |

Dispatch is **at-least-once**. Consumers must deduplicate on `eventId` (outbox row id).

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `OUTBOX_DISPATCH_ENABLED` | `false` | Poll and publish; keep `false` in production until transport exists |
| `OUTBOX_POLL_INTERVAL_MS` | `1000` | Dispatcher interval when enabled |
| `OUTBOX_BATCH_SIZE` | `50` | Claim batch size |
| `OUTBOX_LEASE_MS` | `30000` | Claim lease duration |
| `OUTBOX_MAX_ATTEMPTS` | `25` | Publish attempts before quiescing a row |
| `OUTBOX_RETENTION_DAYS` | `7` | Delete **dispatched** rows older than this |
| `OUTBOX_RETENTION_BATCH_SIZE` | `500` | Retention delete batch |

Pending and failed rows are never deleted by retention.

## Multi-instance

Safe for a **single API instance** with one dispatcher loop. Multiple replicas require a shared realtime bus and coordinated dispatch before enabling delivery at scale.

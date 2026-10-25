BEGIN;
ALTER TABLE outbox_events ALTER COLUMN conversation_id DROP NOT NULL;
ALTER TABLE outbox_events ADD COLUMN deduplication_key VARCHAR(200);
CREATE UNIQUE INDEX outbox_events_deduplication_key_key ON outbox_events(deduplication_key);
-- Existing conversation rows are preserved; the new application event family cannot
-- accidentally acquire a conversation identity, and conversation events still require it.
ALTER TABLE outbox_events ADD CONSTRAINT outbox_event_scope CHECK (
  (type IN ('application.viewing.changed','application.lifecycle.changed') AND conversation_id IS NULL)
  OR (type NOT IN ('application.viewing.changed','application.lifecycle.changed') AND conversation_id IS NOT NULL)
);
COMMIT;

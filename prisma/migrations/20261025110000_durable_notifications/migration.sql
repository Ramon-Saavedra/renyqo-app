BEGIN;
CREATE UNIQUE INDEX application_activities_id_application_id_key ON application_activities(id, application_id);
CREATE TABLE notifications (
 id UUID PRIMARY KEY,
 recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 recipient_side "ViewingParticipantSide" NOT NULL,
 application_id UUID NOT NULL,
 listing_id UUID NOT NULL,
 source_activity_id UUID NOT NULL,
 type "ApplicationActivityType" NOT NULL,
 workflow_id UUID, proposal_id UUID, appointment_id UUID,
 section VARCHAR(16) NOT NULL CHECK (section IN ('APPLICATION', 'VIEWING')),
 occurred_at TIMESTAMPTZ(3) NOT NULL,
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 read_at TIMESTAMPTZ(3),
 expires_at TIMESTAMPTZ(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '90 days'),
 CONSTRAINT notification_retention CHECK (expires_at > created_at),
 CONSTRAINT notification_application FOREIGN KEY(application_id, listing_id) REFERENCES applications(id, listing_id) ON DELETE CASCADE,
 CONSTRAINT notification_activity FOREIGN KEY(source_activity_id, application_id) REFERENCES application_activities(id, application_id) ON DELETE CASCADE,
 CONSTRAINT notifications_source_activity_id_recipient_id_key UNIQUE(source_activity_id, recipient_id)
);
CREATE INDEX notifications_recipient_id_created_at_id_idx ON notifications(recipient_id, created_at, id);
CREATE INDEX notifications_recipient_id_read_at_idx ON notifications(recipient_id, read_at);
CREATE INDEX notifications_expires_at_idx ON notifications(expires_at);
ALTER TABLE outbox_events ALTER COLUMN application_id DROP NOT NULL;
ALTER TABLE outbox_events ADD COLUMN user_id UUID;
ALTER TABLE outbox_events DROP CONSTRAINT outbox_event_scope;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_event_scope CHECK (
 (type = 'notifications.changed' AND user_id IS NOT NULL AND application_id IS NULL AND conversation_id IS NULL)
 OR (type IN ('application.viewing.changed','application.lifecycle.changed') AND application_id IS NOT NULL AND conversation_id IS NULL AND user_id IS NULL)
 OR (type NOT IN ('notifications.changed','application.viewing.changed','application.lifecycle.changed') AND application_id IS NOT NULL AND conversation_id IS NOT NULL AND user_id IS NULL)
);
COMMIT;

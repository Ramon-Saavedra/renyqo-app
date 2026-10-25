BEGIN;
ALTER TABLE application_consideration_positions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0);
CREATE TABLE application_no_show_consequences (
 outcome_id UUID PRIMARY KEY REFERENCES application_viewing_outcomes(id) ON DELETE RESTRICT,
 application_id UUID NOT NULL,
 listing_id UUID NOT NULL,
 previous_position BIGINT NOT NULL CHECK (previous_position > 0),
 applied_position BIGINT NOT NULL CHECK (applied_position > previous_position),
 applied_revision INTEGER NOT NULL CHECK (applied_revision > 0),
 corrected_by_outcome_id UUID UNIQUE REFERENCES application_viewing_outcomes(id) ON DELETE RESTRICT,
 corrected_at TIMESTAMPTZ(3),
 position_restored BOOLEAN,
 FOREIGN KEY (application_id, listing_id) REFERENCES applications(id,listing_id) ON DELETE RESTRICT,
 CHECK ((corrected_by_outcome_id IS NULL AND corrected_at IS NULL AND position_restored IS NULL) OR (corrected_by_outcome_id IS NOT NULL AND corrected_at IS NOT NULL AND position_restored IS NOT NULL))
);
CREATE INDEX application_no_show_consequences_application_id_idx ON application_no_show_consequences(application_id);

-- Phase 2 snapshots were not maintained. Establish the actual visible ACTIVE order
-- at activation of this phase; preserve inactive history and never infer old penalties.
SELECT setval(pg_get_serial_sequence('application_consideration_positions','position'), GREATEST(COALESCE((SELECT max(position) FROM application_consideration_positions),1), (SELECT last_value FROM application_consideration_positions_position_seq)), true);
DO $$ DECLARE app RECORD; BEGIN
 FOR app IN SELECT id,listing_id FROM applications WHERE status='active' ORDER BY listing_id,active_at ASC NULLS LAST,id LOOP
  INSERT INTO application_consideration_positions(application_id,listing_id) VALUES(app.id,app.listing_id)
  ON CONFLICT(application_id) DO UPDATE SET position=EXCLUDED.position, revision=application_consideration_positions.revision+1;
 END LOOP;
END $$;

CREATE FUNCTION guard_active_consideration_position() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Consideration history cannot be deleted' USING ERRCODE='23514'; END IF;
 IF NEW.application_id<>OLD.application_id OR NEW.listing_id<>OLD.listing_id OR NEW.position=OLD.position OR NEW.revision<>OLD.revision+1 THEN
  RAISE EXCEPTION 'Ordering changes require immutable identity, a new position and the next revision' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER consideration_position_guard BEFORE UPDATE OR DELETE ON application_consideration_positions FOR EACH ROW EXECUTE FUNCTION guard_active_consideration_position();

CREATE FUNCTION assign_active_consideration_position() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='active' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
  PERFORM id FROM listings WHERE id=NEW.listing_id FOR UPDATE;
  INSERT INTO application_consideration_positions(application_id,listing_id) VALUES(NEW.id,NEW.listing_id)
  ON CONFLICT(application_id) DO UPDATE SET position=EXCLUDED.position, revision=application_consideration_positions.revision+1;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER application_active_consideration AFTER INSERT OR UPDATE OF status ON applications FOR EACH ROW EXECUTE FUNCTION assign_active_consideration_position();

CREATE FUNCTION guard_no_show_consequence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Attendance consequences are retained' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM application_viewing_outcomes o JOIN application_viewings v ON v.id=o.viewing_id WHERE o.id=NEW.outcome_id AND v.application_id=NEW.application_id AND o.outcome='no_show' AND o.absence_side='applicant') THEN
  RAISE EXCEPTION 'An applicant-attributed outcome is required' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND (ROW(NEW.outcome_id,NEW.application_id,NEW.listing_id,NEW.previous_position,NEW.applied_position,NEW.applied_revision) IS DISTINCT FROM ROW(OLD.outcome_id,OLD.application_id,OLD.listing_id,OLD.previous_position,OLD.applied_position,OLD.applied_revision) OR OLD.corrected_by_outcome_id IS NOT NULL) THEN
  RAISE EXCEPTION 'Attendance source and reconciled corrections are immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.corrected_by_outcome_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM application_viewing_outcomes correction JOIN application_viewing_outcomes source ON source.id=NEW.outcome_id
  WHERE correction.id=NEW.corrected_by_outcome_id AND correction.viewing_id=source.viewing_id AND correction.revision>source.revision AND (correction.outcome<>'no_show' OR correction.absence_side IS DISTINCT FROM 'applicant'::"ViewingAbsenceSide") AND correction.recorded_at=NEW.corrected_at
 ) THEN RAISE EXCEPTION 'Correction must reverse this exact attendance outcome' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER no_show_consequence_guard BEFORE INSERT OR UPDATE OR DELETE ON application_no_show_consequences FOR EACH ROW EXECUTE FUNCTION guard_no_show_consequence();
COMMIT;

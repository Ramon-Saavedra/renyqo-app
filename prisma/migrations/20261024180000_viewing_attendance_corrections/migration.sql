CREATE OR REPLACE FUNCTION guard_viewing_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original_outcome "ViewingOutcome"; original_absence "ViewingAbsenceSide";
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Viewing decisions are append-only' USING ERRCODE='23514'; END IF;
 UPDATE application_viewings SET updated_at=updated_at WHERE id=NEW.viewing_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Viewing does not exist' USING ERRCODE='23503'; END IF;
 IF TG_TABLE_NAME='application_viewing_outcomes' THEN
 IF NEW.revision=2 THEN
  SELECT outcome,absence_side INTO original_outcome,original_absence FROM application_viewing_outcomes WHERE viewing_id=NEW.viewing_id AND revision=1;
  IF NOT FOUND OR ROW(original_outcome,original_absence) IS NOT DISTINCT FROM ROW(NEW.outcome,NEW.absence_side) THEN
   RAISE EXCEPTION 'Correction requires a preceding different outcome or absence attribution' USING ERRCODE='23514';
  END IF;
 END IF;
 END IF;
 RETURN NEW;
END $$;



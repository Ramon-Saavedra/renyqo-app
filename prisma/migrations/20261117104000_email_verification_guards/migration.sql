BEGIN;
CREATE FUNCTION invalidate_changed_email_verification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    NEW.email_verified:=false;
    UPDATE email_verification_challenges SET used_at=clock_timestamp() WHERE user_id=NEW.id AND used_at IS NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER user_email_verification_reset BEFORE UPDATE OF email ON users FOR EACH ROW EXECUTE FUNCTION invalidate_changed_email_verification();
CREATE FUNCTION guard_email_verification_challenge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Verification proof history is durable' USING ERRCODE='23514'; END IF;
  IF (to_jsonb(NEW)-'used_at') IS DISTINCT FROM (to_jsonb(OLD)-'used_at') OR OLD.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'Verification challenge is immutable or consumed' USING ERRCODE='23514'; END IF;
  IF NEW.used_at IS NULL THEN RAISE EXCEPTION 'Verification consumption is terminal' USING ERRCODE='23514'; END IF;
  NEW.used_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER email_verification_terminal BEFORE UPDATE OR DELETE ON email_verification_challenges FOR EACH ROW EXECUTE FUNCTION guard_email_verification_challenge();
DO $$ DECLARE s text:=current_schema(); BEGIN
  EXECUTE format('ALTER FUNCTION %I.invalidate_changed_email_verification() SET search_path=pg_catalog,%I,pg_temp',s,s);
  EXECUTE format('ALTER FUNCTION %I.guard_email_verification_challenge() SET search_path=pg_catalog,%I,pg_temp',s,s);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.invalidate_changed_email_verification(),%I.guard_email_verification_challenge() FROM PUBLIC',s,s);
END $$;
COMMIT;

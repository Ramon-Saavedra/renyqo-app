BEGIN;
ALTER TABLE listings ADD COLUMN predecessor_listing_id uuid,
  ADD CONSTRAINT listing_predecessor_tenant FOREIGN KEY(predecessor_listing_id,workspace_id) REFERENCES listings(id,workspace_id) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE listing_assignment_transitions ADD COLUMN creation_input_hash varchar(64);
CREATE FUNCTION guard_listing_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.predecessor_listing_id IS DISTINCT FROM OLD.predecessor_listing_id THEN
    RAISE EXCEPTION 'Listing lineage is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' AND NEW.predecessor_listing_id IS NOT NULL AND NOT EXISTS(
    SELECT FROM listings WHERE id=NEW.predecessor_listing_id AND workspace_id=NEW.workspace_id AND status='retired') THEN
    RAISE EXCEPTION 'Relisting requires a same-workspace retired predecessor' USING ERRCODE='23514',CONSTRAINT='listing_predecessor';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER listing_lineage_guard BEFORE INSERT OR UPDATE ON listings FOR EACH ROW EXECUTE FUNCTION guard_listing_lineage();
DO $$ DECLARE s text:=current_schema(); BEGIN
  EXECUTE format('ALTER FUNCTION %I.guard_listing_lineage() SECURITY DEFINER',s);
  EXECUTE format('ALTER FUNCTION %I.guard_listing_lineage() SET search_path=pg_catalog,%I,pg_temp',s,s);
  EXECUTE format('ALTER FUNCTION %I.guard_listing_lineage() OWNER TO renyqo_workspace_invariants',s);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.guard_listing_lineage() FROM PUBLIC',s);
END $$;
COMMIT;

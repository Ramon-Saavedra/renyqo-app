BEGIN;
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
LOCK TABLE provider_workspaces IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE workspace_memberships IN ACCESS EXCLUSIVE MODE;

CREATE FUNCTION member_color_ids() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
 SELECT ARRAY['ROYAL_BLUE','BURGUNDY','DARK_PURPLE','STRONG_VIOLET','PETROL_BLUE','STRONG_CYAN','TURQUOISE','EMERALD_GREEN','STRONG_GREEN','LIME_GREEN','INDUSTRIAL_YELLOW','STRONG_ORANGE','STRONG_RED','FUCHSIA','MAGENTA','COPPER','INDIGO']::text[]
$$;
CREATE FUNCTION legacy_member_color(value text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE upper(value)
  WHEN '#2563EB' THEN 'ROYAL_BLUE' WHEN '#7C3AED' THEN 'STRONG_VIOLET'
  WHEN '#123456' THEN 'PETROL_BLUE' WHEN '#112233' THEN 'PETROL_BLUE'
  WHEN '#654321' THEN 'COPPER' WHEN '#DB2777' THEN 'MAGENTA'
  WHEN '#000000' THEN 'DARK_PURPLE' ELSE NULL END
$$;
DO $$ BEGIN
 IF EXISTS(SELECT FROM workspace_memberships WHERE legacy_member_color(display_color) IS NULL) THEN
  RAISE EXCEPTION 'Unknown legacy membership color: explicit mapping review required';
 END IF;
END $$;
ALTER TABLE workspace_memberships DROP CONSTRAINT workspace_memberships_display_color_check;
ALTER TABLE workspace_memberships ALTER COLUMN display_color TYPE varchar(32);
-- Explicitly approved normalization exception. DDL lock excludes concurrent
-- changes; no identity, timestamp or authority epoch is rewritten.
ALTER TABLE workspace_memberships DISABLE TRIGGER membership_identity_guard;
DO $$ DECLARE w record; BEGIN
 FOR w IN SELECT id,ownership_revision FROM provider_workspaces ORDER BY id LOOP
  PERFORM set_config('app.workspace_id',w.id::text,true),set_config('app.tenant_xid',pg_current_xact_id()::text,true);
  PERFORM lock_workspace_ownership_revision(w.id,w.ownership_revision);
  WITH ordered AS (
   SELECT id,row_number() OVER(ORDER BY created_at,id)-1 AS n FROM workspace_memberships WHERE workspace_id=w.id AND status<>'REMOVED'
  ) UPDATE workspace_memberships m SET display_color=(member_color_ids())[1+(o.n%cardinality(member_color_ids()))::integer] FROM ordered o WHERE m.id=o.id;
  UPDATE workspace_memberships SET display_color=legacy_member_color(display_color) WHERE workspace_id=w.id AND status='REMOVED';
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
 END LOOP;
END $$;
ALTER TABLE workspace_memberships ENABLE TRIGGER membership_identity_guard;
ALTER TABLE workspace_memberships ADD CONSTRAINT workspace_memberships_display_color_check CHECK(display_color=ANY(member_color_ids()));
ALTER TABLE workspace_invitations ADD COLUMN requested_color_id varchar(32) CHECK(requested_color_id IS NULL OR requested_color_id=ANY(member_color_ids()));
DO $$ DECLARE s text:=current_schema(); BEGIN
 EXECUTE format('ALTER FUNCTION %I.member_color_ids() SET search_path=pg_catalog,%I,pg_temp',s,s);
 EXECUTE format('ALTER FUNCTION %I.legacy_member_color(text) SET search_path=pg_catalog,%I,pg_temp',s,s);
 EXECUTE format('REVOKE ALL ON FUNCTION %I.member_color_ids(),%I.legacy_member_color(text) FROM PUBLIC',s,s);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %I.member_color_ids() TO renyqo_workspace_runtime,renyqo_workspace_invariants',s);
END $$;
COMMIT;

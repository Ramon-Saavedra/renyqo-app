BEGIN;
CREATE FUNCTION select_member_color(target uuid,requested text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE selected text;
BEGIN
 PERFORM assert_workspace_tenant(target);
 IF requested IS NOT NULL AND NOT requested=ANY(member_color_ids()) THEN RAISE EXCEPTION 'Canonical member color required' USING ERRCODE='23514',CONSTRAINT='member_color_identifier'; END IF;
 -- The first membership's parent was created in this transaction. Established
 -- workspaces use precisely the existing Serializable/root-baseline protocol.
 IF EXISTS(SELECT FROM workspace_memberships WHERE workspace_id=target) THEN PERFORM assert_capacity_transaction(target); END IF;
 IF requested IS NOT NULL AND NOT EXISTS(SELECT FROM workspace_memberships WHERE workspace_id=target AND status<>'REMOVED' AND display_color=requested) THEN RETURN requested; END IF;
 SELECT p.id INTO STRICT selected FROM unnest(member_color_ids()) WITH ORDINALITY p(id,ordinal)
 LEFT JOIN workspace_memberships m ON m.workspace_id=target AND m.status<>'REMOVED' AND m.display_color=p.id
 GROUP BY p.id,p.ordinal ORDER BY count(m.id),p.ordinal LIMIT 1;
 RETURN selected;
END $$;
CREATE FUNCTION assign_member_color() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.display_color:=select_member_color(NEW.workspace_id,NEW.display_color);RETURN NEW; END $$;
CREATE TRIGGER member_color_admission BEFORE INSERT ON workspace_memberships FOR EACH ROW EXECUTE FUNCTION assign_member_color();
CREATE FUNCTION preserve_invitation_color_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.requested_color_id IS DISTINCT FROM OLD.requested_color_id THEN RAISE EXCEPTION 'Invitation color intent is immutable' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER invitation_color_intent BEFORE UPDATE ON workspace_invitations FOR EACH ROW EXECUTE FUNCTION preserve_invitation_color_intent();
DO $$ DECLARE s text:=current_schema();f text; BEGIN
 FOREACH f IN ARRAY ARRAY['select_member_color(uuid,text)','assign_member_color()','preserve_invitation_color_intent()'] LOOP
  EXECUTE format('ALTER FUNCTION %I.%s SECURITY DEFINER',s,f);
  EXECUTE format('ALTER FUNCTION %I.%s SET search_path=pg_catalog,%I,pg_temp',s,f,s);
  EXECUTE format('ALTER FUNCTION %I.%s OWNER TO renyqo_workspace_invariants',s,f);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM PUBLIC',s,f);
 END LOOP;
END $$;
COMMIT;

BEGIN;

-- Deliberately refuse implicit ownership backfill or historical reinterpretation.
-- The coordinated release must complete its separately authorized bounded reset.
DO $$ BEGIN
  IF EXISTS (SELECT FROM listings) THEN
    RAISE EXCEPTION 'Listing cutover requires the authorized disposable provider-data reset';
  END IF;
END $$;

ALTER TABLE listings DROP CONSTRAINT listings_provider_id_fkey;
DROP INDEX listings_provider_id_display_order_key;
DROP INDEX listings_provider_id_display_order_id_idx;
ALTER TABLE listings DROP COLUMN provider_id,
  ADD COLUMN workspace_id uuid NOT NULL REFERENCES provider_workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD COLUMN created_by_membership_id uuid NOT NULL,
  ADD COLUMN responsible_membership_id uuid NOT NULL,
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  ADD COLUMN assignment_sequence integer NOT NULL DEFAULT 1 CHECK (assignment_sequence>0),
  ADD COLUMN retired_at timestamptz(3),
  ALTER COLUMN display_order DROP NOT NULL,
  ADD CONSTRAINT listings_id_workspace_key UNIQUE(id,workspace_id),
  ADD CONSTRAINT listings_creator_tenant FOREIGN KEY(created_by_membership_id,workspace_id)
    REFERENCES workspace_memberships(id,workspace_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT listings_responsible_tenant FOREIGN KEY(responsible_membership_id,workspace_id)
    REFERENCES workspace_memberships(id,workspace_id) ON UPDATE RESTRICT ON DELETE RESTRICT;

-- No ARCHIVED rows survive the reset. Preserve no compatibility enum value.
ALTER TYPE "ListingStatus" RENAME TO "LegacyListingStatus";
CREATE TYPE "ListingStatus" AS ENUM ('draft','published','paused','rented','retired');
ALTER TABLE listings ALTER COLUMN status DROP DEFAULT;
ALTER TABLE listings ALTER COLUMN status TYPE "ListingStatus" USING status::text::"ListingStatus";
ALTER TABLE listings ALTER COLUMN status SET DEFAULT 'draft';
DROP TYPE "LegacyListingStatus";
ALTER TYPE "ViewingClosureReason" RENAME VALUE 'listing_archived' TO 'listing_retired';
ALTER TABLE listings ADD CONSTRAINT listing_retirement_shape CHECK (
  (status='retired' AND retired_at IS NOT NULL AND display_order IS NULL) OR
  (status<>'retired' AND retired_at IS NULL AND display_order>0 AND display_order IS NOT NULL));
CREATE UNIQUE INDEX listing_active_workspace_order ON listings(workspace_id,display_order) WHERE status<>'retired';
CREATE INDEX listing_responsibility ON listings(workspace_id,responsible_membership_id,id);

CREATE TYPE "ListingAssignmentReason" AS ENUM ('INITIAL','OWNER_REASSIGNMENT','APPROVED_TRANSFER','MEMBERSHIP_REMOVAL');
CREATE TYPE "ListingTransferStatus" AS ENUM ('REQUESTED','APPROVED','REJECTED','CANCELLED','EXPIRED');

CREATE TABLE listing_transfer_requests (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  listing_id uuid NOT NULL,
  source_membership_id uuid NOT NULL,
  target_membership_id uuid NOT NULL,
  expected_listing_revision integer NOT NULL CHECK(expected_listing_revision>0),
  expected_source_revision integer NOT NULL CHECK(expected_source_revision>0),
  expected_target_revision integer NOT NULL CHECK(expected_target_revision>0),
  expected_ownership_revision integer NOT NULL CHECK(expected_ownership_revision>0),
  status "ListingTransferStatus" NOT NULL DEFAULT 'REQUESTED',
  command_id uuid NOT NULL,
  correlation_id uuid,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz(3) NOT NULL,
  decided_at timestamptz(3),
  decided_by_membership_id uuid,
  UNIQUE(id,workspace_id), UNIQUE(workspace_id,command_id),
  CHECK(source_membership_id<>target_membership_id),
  CHECK(expires_at>created_at),
  FOREIGN KEY(listing_id,workspace_id) REFERENCES listings(id,workspace_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(source_membership_id,workspace_id) REFERENCES workspace_memberships(id,workspace_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(target_membership_id,workspace_id) REFERENCES workspace_memberships(id,workspace_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(decided_by_membership_id,workspace_id) REFERENCES workspace_memberships(id,workspace_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE UNIQUE INDEX listing_one_requested_transfer ON listing_transfer_requests(workspace_id,listing_id) WHERE status='REQUESTED';

CREATE TABLE listing_assignment_transitions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  listing_id uuid NOT NULL,
  sequence integer NOT NULL CHECK(sequence>0),
  previous_membership_id uuid,
  new_membership_id uuid NOT NULL,
  reason "ListingAssignmentReason" NOT NULL,
  initiated_by_membership_id uuid NOT NULL,
  approved_by_membership_id uuid,
  transfer_request_id uuid,
  command_id uuid NOT NULL,
  correlation_id uuid,
  occurred_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(listing_id,sequence), UNIQUE(workspace_id,command_id), UNIQUE(transfer_request_id),
  FOREIGN KEY(listing_id,workspace_id) REFERENCES listings(id,workspace_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT assignment_previous_tenant FOREIGN KEY(previous_membership_id,workspace_id) REFERENCES workspace_memberships(id,workspace_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT assignment_new_tenant FOREIGN KEY(new_membership_id,workspace_id) REFERENCES workspace_memberships(id,workspace_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT assignment_initiator_tenant FOREIGN KEY(initiated_by_membership_id,workspace_id) REFERENCES workspace_memberships(id,workspace_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT assignment_approver_tenant FOREIGN KEY(approved_by_membership_id,workspace_id) REFERENCES workspace_memberships(id,workspace_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT assignment_request_tenant FOREIGN KEY(transfer_request_id,workspace_id) REFERENCES listing_transfer_requests(id,workspace_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK((sequence=1 AND reason='INITIAL' AND previous_membership_id IS NULL) OR
    (sequence>1 AND reason<>'INITIAL' AND previous_membership_id IS NOT NULL AND previous_membership_id<>new_membership_id))
);

-- Public data only: explicitly allowlisted applicant-facing requirements;
-- no membership/tenant identifiers or internal eligibility criteria,
-- private address, storage keys, application state or internal metadata.
-- Existing public applicant-facing requirements are explicitly allowlisted.
CREATE TABLE public_listing_projections (
  id uuid PRIMARY KEY REFERENCES listings(id) ON DELETE RESTRICT,
  title text, city text, zip text, district text, country text NOT NULL,
  object_type "ObjectType", living_area double precision, rooms double precision,
  bedrooms double precision, cold_rent double precision, additional_costs double precision,
  deposit double precision, deposit_months integer NOT NULL, available_from timestamp(3),
  short_description text, public_street text, photos text[] NOT NULL,
  published_at timestamp(3) NOT NULL,
  minimum_household_net_income double precision,
  schufa_required boolean NOT NULL, income_proof_required boolean NOT NULL, suitable_for_people_count integer,
  pets_policy "PetsPolicy", smoking_policy "SmokingPolicy"
);

-- Private derived routing index. It grants no authority and is constrained to
-- the canonical immutable Listing pair; never returned as a public projection.
CREATE TABLE listing_tenant_routes (
  listing_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  FOREIGN KEY(listing_id,workspace_id) REFERENCES listings(id,workspace_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

DO $$ DECLARE s text:=current_schema(); t text; predicate text;
BEGIN
  FOREACH t IN ARRAY ARRAY['listings','listing_assignment_transitions','listing_transfer_requests'] LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',s,t);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',s,t);
    EXECUTE format('ALTER TABLE %I.%I OWNER TO renyqo_workspace_owner',s,t);
    EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC,renyqo_workspace_runtime',s,t);
    predicate:=format('workspace_id=(SELECT %I.current_workspace_id())',s);
    EXECUTE format('CREATE POLICY listing_tenant ON %I.%I TO renyqo_workspace_runtime,renyqo_workspace_invariants USING(%s) WITH CHECK(%s)',s,t,predicate,predicate);
    EXECUTE format('CREATE POLICY listing_tenant_fence ON %I.%I AS RESTRICTIVE TO renyqo_workspace_runtime,renyqo_workspace_invariants USING(%s) WITH CHECK(%s)',s,t,predicate,predicate);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I.%I TO renyqo_workspace_invariants',s,t);
    EXECUTE format('GRANT SELECT,INSERT ON %I.%I TO renyqo_workspace_runtime',s,t);
    IF t<>'listing_assignment_transitions' THEN
      EXECUTE format('GRANT UPDATE ON %I.%I TO renyqo_workspace_runtime',s,t);
    END IF;
  END LOOP;
  EXECUTE format('ALTER TABLE %I.public_listing_projections OWNER TO renyqo_workspace_owner',s);
  EXECUTE format('REVOKE ALL ON %I.public_listing_projections FROM PUBLIC,renyqo_workspace_runtime',s);
  EXECUTE format('GRANT SELECT ON %I.public_listing_projections TO renyqo_workspace_runtime',s);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I.public_listing_projections TO renyqo_workspace_invariants',s);
  EXECUTE format('ALTER TABLE %I.listing_tenant_routes OWNER TO renyqo_workspace_owner',s);
  EXECUTE format('REVOKE ALL ON %I.listing_tenant_routes FROM PUBLIC,renyqo_workspace_runtime',s);
  EXECUTE format('GRANT INSERT ON %I.listing_tenant_routes TO renyqo_workspace_invariants',s);
END $$;

CREATE FUNCTION guard_listing_assignment_root() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m workspace_memberships%ROWTYPE; w provider_workspaces%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Retirement preserves listing history' USING ERRCODE='23514'; END IF;
  PERFORM assert_workspace_tenant(NEW.workspace_id);
  IF NOT EXISTS(SELECT FROM workspace_ownership_revision_baselines
    WHERE workspace_id=NEW.workspace_id AND transaction_id=pg_current_xact_id()::text) THEN
    RAISE EXCEPTION 'Acquire workspace structural lock before Listing writes' USING ERRCODE='23514';
  END IF;
  SELECT * INTO STRICT w FROM provider_workspaces WHERE id=NEW.workspace_id;
  IF w.lifecycle_status<>'ACTIVE' THEN RAISE EXCEPTION 'Workspace is not operational' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.id,NEW.workspace_id,NEW.created_by_membership_id,NEW.created_at) IS DISTINCT FROM
      ROW(OLD.id,OLD.workspace_id,OLD.created_by_membership_id,OLD.created_at) THEN
      RAISE EXCEPTION 'Listing ownership and creator are immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.revision<>OLD.revision OR NEW.assignment_sequence<>OLD.assignment_sequence THEN
      RAISE EXCEPTION 'Listing revisions are database-derived' USING ERRCODE='23514';
    END IF;
    IF OLD.status='retired' AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'RETIRED listing is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.status<>OLD.status AND NOT (
      (OLD.status='draft' AND NEW.status IN('published','retired')) OR
      (OLD.status='published' AND NEW.status IN('draft','paused','rented','retired')) OR
      (OLD.status='paused' AND NEW.status IN('draft','published','rented','retired')) OR
      (OLD.status='rented' AND NEW.status='retired')
    ) THEN RAISE EXCEPTION 'Invalid Listing lifecycle transition' USING ERRCODE='23514'; END IF;
    -- Technical temporary ordering positions do not invalidate assignment state.
    IF (to_jsonb(NEW)-ARRAY['display_order','updated_at']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['display_order','updated_at']) THEN
      NEW.revision:=OLD.revision+1;
    END IF;
    IF NEW.responsible_membership_id<>OLD.responsible_membership_id THEN
      NEW.assignment_sequence:=OLD.assignment_sequence+1;
    END IF;
    IF NEW.status='retired' AND OLD.status<>'retired' THEN
      NEW.retired_at:=clock_timestamp();NEW.display_order:=NULL;
    ELSIF NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
      RAISE EXCEPTION 'Retirement timestamp is database-derived' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.status<>'draft' OR NEW.revision<>1 OR NEW.assignment_sequence<>1 OR NEW.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'Listing establishes DRAFT at revision one' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' OR NEW.responsible_membership_id<>OLD.responsible_membership_id THEN
    SELECT * INTO m FROM workspace_memberships WHERE id=NEW.responsible_membership_id AND workspace_id=NEW.workspace_id;
    IF NOT FOUND OR m.status<>'ACTIVE' OR NOT EXISTS(SELECT FROM users WHERE id=m.user_id AND status='active') THEN
      RAISE EXCEPTION 'New responsibility requires an eligible ACTIVE membership' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_OP='INSERT' OR NEW IS DISTINCT FROM OLD THEN NEW.updated_at:=clock_timestamp() AT TIME ZONE 'UTC'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER listing_assignment_root_guard BEFORE INSERT OR UPDATE OR DELETE ON listings
  FOR EACH ROW EXECUTE FUNCTION guard_listing_assignment_root();

CREATE FUNCTION guard_listing_assignment_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l listings%ROWTYPE; previous listing_assignment_transitions%ROWTYPE;
  actor workspace_memberships%ROWTYPE; approval workspace_memberships%ROWTYPE; request listing_transfer_requests%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Assignment evidence is append-only' USING ERRCODE='23514'; END IF;
  PERFORM assert_workspace_tenant(NEW.workspace_id);
  SELECT * INTO STRICT l FROM listings WHERE id=NEW.listing_id AND workspace_id=NEW.workspace_id;
  SELECT * INTO previous FROM listing_assignment_transitions WHERE listing_id=l.id ORDER BY sequence DESC LIMIT 1;
  SELECT * INTO actor FROM workspace_memberships WHERE id=NEW.initiated_by_membership_id AND workspace_id=NEW.workspace_id;
  IF actor.id IS NULL OR actor.status<>'ACTIVE' OR NOT EXISTS(SELECT FROM users WHERE id=actor.user_id AND status='active') THEN
    RAISE EXCEPTION 'Assignment initiator is ineligible' USING ERRCODE='23514';
  END IF;
  IF NEW.reason='INITIAL' AND (actor.id<>l.created_by_membership_id OR (actor.role<>'OWNER' AND actor.id<>NEW.new_membership_id)) THEN
    RAISE EXCEPTION 'Invalid initial responsibility' USING ERRCODE='23514';
  END IF;
  IF NEW.reason IN ('OWNER_REASSIGNMENT','MEMBERSHIP_REMOVAL') AND actor.role<>'OWNER' THEN
    RAISE EXCEPTION 'OWNER required for direct reassignment' USING ERRCODE='23514';
  END IF;
  IF NEW.reason='APPROVED_TRANSFER' THEN
    SELECT * INTO request FROM listing_transfer_requests WHERE id=NEW.transfer_request_id AND workspace_id=NEW.workspace_id;
    SELECT * INTO approval FROM workspace_memberships WHERE id=NEW.approved_by_membership_id AND workspace_id=NEW.workspace_id;
    IF request.id IS NULL OR request.status<>'APPROVED' OR request.listing_id<>l.id OR
      request.source_membership_id<>NEW.previous_membership_id OR request.target_membership_id<>NEW.new_membership_id OR
      request.source_membership_id<>actor.id OR request.decided_by_membership_id IS DISTINCT FROM approval.id OR
      approval.id IS NULL OR approval.role<>'OWNER' OR approval.status<>'ACTIVE' OR l.revision<>request.expected_listing_revision+1 THEN
      RAISE EXCEPTION 'Assignment does not match approved transfer' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.transfer_request_id IS NOT NULL THEN
    RAISE EXCEPTION 'Only approved transfer evidence references a request' USING ERRCODE='23514';
  END IF;
  IF NEW.sequence<>COALESCE(previous.sequence,0)+1 OR NEW.sequence<>l.assignment_sequence OR
    NEW.previous_membership_id IS DISTINCT FROM previous.new_membership_id OR
    NEW.new_membership_id<>l.responsible_membership_id THEN
    RAISE EXCEPTION 'Assignment evidence does not match Listing transition' USING ERRCODE='23514';
  END IF;
  NEW.occurred_at:=clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER listing_assignment_evidence_guard BEFORE INSERT OR UPDATE OR DELETE ON listing_assignment_transitions
  FOR EACH ROW EXECUTE FUNCTION guard_listing_assignment_evidence();

CREATE FUNCTION check_listing_assignment_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l listings%ROWTYPE; e listing_assignment_transitions%ROWTYPE;
BEGIN
  PERFORM assert_workspace_tenant(NEW.workspace_id);
  SELECT * INTO STRICT l FROM listings WHERE id=NEW.id AND workspace_id=NEW.workspace_id;
  SELECT * INTO e FROM listing_assignment_transitions WHERE listing_id=l.id ORDER BY sequence DESC LIMIT 1;
  IF e.id IS NULL OR e.sequence<>l.assignment_sequence OR e.new_membership_id<>l.responsible_membership_id THEN
    RAISE EXCEPTION 'Listing mutation requires atomic assignment evidence' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER listing_assignment_commit_check AFTER INSERT OR UPDATE ON listings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_listing_assignment_evidence();

CREATE FUNCTION guard_member_listing_responsibility() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_workspace_tenant(NEW.workspace_id);
  IF NEW.status='REMOVED' AND OLD.status<>'REMOVED' AND EXISTS(
    SELECT FROM listings WHERE workspace_id=NEW.workspace_id AND responsible_membership_id=NEW.id AND status<>'retired') THEN
    RAISE EXCEPTION 'Reassign operational listings before membership removal' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER membership_listing_responsibility_guard BEFORE UPDATE ON workspace_memberships
  FOR EACH ROW EXECUTE FUNCTION guard_member_listing_responsibility();

CREATE FUNCTION refresh_public_listing_projection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_workspace_tenant(NEW.workspace_id);
  IF TG_OP='INSERT' THEN INSERT INTO listing_tenant_routes(listing_id,workspace_id) VALUES(NEW.id,NEW.workspace_id); END IF;
  IF NEW.status='published' AND NEW.published_at IS NOT NULL THEN
    INSERT INTO public_listing_projections(id,title,city,zip,district,country,object_type,living_area,rooms,bedrooms,
      cold_rent,additional_costs,deposit,deposit_months,available_from,short_description,public_street,photos,published_at,minimum_household_net_income,schufa_required,income_proof_required,suitable_for_people_count,pets_policy,smoking_policy)
    VALUES(NEW.id,NEW.title,NEW.city,NEW.zip,NEW.district,NEW.country,NEW.object_type,NEW.living_area,NEW.rooms,NEW.bedrooms,
      NEW.cold_rent,NEW.additional_costs,NEW.deposit,NEW.deposit_months,NEW.available_from,NEW.short_description,
      CASE WHEN NEW.show_exact_address THEN NEW.street ELSE NULL END,NEW.photos,NEW.published_at,NEW.minimum_household_net_income,NEW.schufa_required,NEW.income_proof_required,NEW.suitable_for_people_count,NEW.pets_policy,NEW.smoking_policy)
    ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,city=EXCLUDED.city,zip=EXCLUDED.zip,district=EXCLUDED.district,
      country=EXCLUDED.country,object_type=EXCLUDED.object_type,living_area=EXCLUDED.living_area,rooms=EXCLUDED.rooms,
      bedrooms=EXCLUDED.bedrooms,cold_rent=EXCLUDED.cold_rent,additional_costs=EXCLUDED.additional_costs,
      deposit=EXCLUDED.deposit,deposit_months=EXCLUDED.deposit_months,available_from=EXCLUDED.available_from,
      short_description=EXCLUDED.short_description,public_street=EXCLUDED.public_street,photos=EXCLUDED.photos,published_at=EXCLUDED.published_at,minimum_household_net_income=EXCLUDED.minimum_household_net_income,schufa_required=EXCLUDED.schufa_required,income_proof_required=EXCLUDED.income_proof_required,suitable_for_people_count=EXCLUDED.suitable_for_people_count,pets_policy=EXCLUDED.pets_policy,smoking_policy=EXCLUDED.smoking_policy;
  ELSE
    DELETE FROM public_listing_projections WHERE id=NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER listing_public_projection AFTER INSERT OR UPDATE ON listings
  FOR EACH ROW EXECUTE FUNCTION refresh_public_listing_projection();

CREATE FUNCTION withdraw_workspace_public_listings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_workspace_tenant(NEW.id);
  IF NEW.lifecycle_status<>'ACTIVE' AND OLD.lifecycle_status='ACTIVE' THEN
    DELETE FROM public_listing_projections p USING listings l
      WHERE p.id=l.id AND l.workspace_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workspace_public_listing_withdrawal AFTER UPDATE OF lifecycle_status ON provider_workspaces
  FOR EACH ROW EXECUTE FUNCTION withdraw_workspace_public_listings();

DO $$ BEGIN
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='renyqo_applicant_listing_resolver') THEN
    CREATE ROLE renyqo_applicant_listing_resolver NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='renyqo_applicant_listing_resolver' AND
    (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreaterole OR rolcreatedb)) THEN
    RAISE EXCEPTION 'Unsafe applicant Listing helper role';
  END IF;
END $$;

CREATE FUNCTION resolve_applicant_listing(authenticated_user uuid, application_selector uuid)
RETURNS TABLE(listing_id uuid,workspace_id uuid) LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY SELECT l.listing_id,l.workspace_id FROM applications a JOIN listing_tenant_routes l ON l.listing_id=a.listing_id
    WHERE a.id=application_selector AND a.applicant_id=authenticated_user;
END $$;

CREATE FUNCTION resolve_public_admission_listing(listing_selector uuid)
RETURNS TABLE(listing_id uuid,workspace_id uuid) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT r.listing_id,r.workspace_id FROM listing_tenant_routes r JOIN public_listing_projections p ON p.id=r.listing_id
    WHERE r.listing_id=listing_selector
$$;

DO $$ DECLARE s text:=current_schema(); f record; source text; token text;
  names text[]:=ARRAY['guard_listing_assignment_root','guard_listing_assignment_evidence',
    'check_listing_assignment_evidence','guard_member_listing_responsibility','refresh_public_listing_projection','withdraw_workspace_public_listings','resolve_applicant_listing','resolve_public_admission_listing'];
  objects text[];
BEGIN
  objects:=ARRAY['listings','workspace_memberships','provider_workspaces','workspace_ownership_revision_baselines',
    'listing_assignment_transitions','listing_transfer_requests','public_listing_projections','applications','users',
    'assert_workspace_tenant','listing_tenant_routes'];
  EXECUTE format('GRANT renyqo_applicant_listing_resolver TO %I',current_user);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO renyqo_applicant_listing_resolver',s);
  EXECUTE format('GRANT SELECT(id,applicant_id,listing_id) ON %I.applications TO renyqo_applicant_listing_resolver',s);
  EXECUTE format('GRANT SELECT ON %I.listing_tenant_routes TO renyqo_applicant_listing_resolver',s);
  EXECUTE format('GRANT SELECT(id) ON %I.public_listing_projections TO renyqo_applicant_listing_resolver',s);
  FOR f IN SELECT p.oid,p.prosrc,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname=s AND p.proname=ANY(names) LOOP
    source:='';
    FOR token IN SELECT(m)[1] FROM regexp_matches(f.prosrc,
      $rx$('(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_][A-Za-z_0-9]*|.)$rx$,'gs') m LOOP
      IF trim(both '"' FROM token)=ANY(objects) AND left(token,1)<>'''' THEN
        source:=source||format('%I.%s',s,token);
      ELSE source:=source||token; END IF;
    END LOOP;
    EXECUTE replace(pg_get_functiondef(f.oid),f.prosrc,source);
    EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',f.oid::regprocedure,s);
    EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER',f.oid::regprocedure);
    EXECUTE format('ALTER FUNCTION %s OWNER TO %I',f.oid::regprocedure,
      CASE WHEN f.proname IN('resolve_applicant_listing','resolve_public_admission_listing') THEN 'renyqo_applicant_listing_resolver' ELSE 'renyqo_workspace_invariants' END);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,renyqo_workspace_runtime',f.oid::regprocedure);
  END LOOP;
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.resolve_applicant_listing(uuid,uuid) TO renyqo_workspace_runtime',s);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.resolve_public_admission_listing(uuid) TO renyqo_workspace_runtime',s);
END $$;

CREATE FUNCTION guard_listing_transfer_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l listings%ROWTYPE; src workspace_memberships%ROWTYPE; dst workspace_memberships%ROWTYPE;
  w provider_workspaces%ROWTYPE; decision workspace_memberships%ROWTYPE; observed timestamptz:=clock_timestamp();
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Transfer request evidence cannot be deleted' USING ERRCODE='23514'; END IF;
  PERFORM assert_workspace_tenant(NEW.workspace_id);
  IF NOT EXISTS(SELECT FROM workspace_ownership_revision_baselines WHERE workspace_id=NEW.workspace_id AND transaction_id=pg_current_xact_id()::text) THEN
    RAISE EXCEPTION 'Lock workspace before transfer request writes' USING ERRCODE='23514';
  END IF;
  SELECT * INTO STRICT l FROM listings WHERE id=NEW.listing_id AND workspace_id=NEW.workspace_id;
  SELECT * INTO STRICT w FROM provider_workspaces WHERE id=NEW.workspace_id;
  SELECT * INTO src FROM workspace_memberships WHERE id=NEW.source_membership_id AND workspace_id=NEW.workspace_id;
  SELECT * INTO dst FROM workspace_memberships WHERE id=NEW.target_membership_id AND workspace_id=NEW.workspace_id;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'REQUESTED' OR NEW.decided_at IS NOT NULL OR NEW.decided_by_membership_id IS NOT NULL THEN
      RAISE EXCEPTION 'Request must establish REQUESTED' USING ERRCODE='23514';
    END IF;
    NEW.created_at:=observed;
  ELSE
    IF ROW(NEW.id,NEW.workspace_id,NEW.listing_id,NEW.source_membership_id,NEW.target_membership_id,
      NEW.expected_listing_revision,NEW.expected_source_revision,NEW.expected_target_revision,NEW.expected_ownership_revision,
      NEW.command_id,NEW.correlation_id,NEW.created_at,NEW.expires_at) IS DISTINCT FROM
      ROW(OLD.id,OLD.workspace_id,OLD.listing_id,OLD.source_membership_id,OLD.target_membership_id,
      OLD.expected_listing_revision,OLD.expected_source_revision,OLD.expected_target_revision,OLD.expected_ownership_revision,
      OLD.command_id,OLD.correlation_id,OLD.created_at,OLD.expires_at) THEN
      RAISE EXCEPTION 'Transfer request terms are immutable' USING ERRCODE='23514';
    END IF;
    IF OLD.status<>'REQUESTED' OR NEW.status='REQUESTED' THEN
      RAISE EXCEPTION 'Transfer request already decided or unchanged' USING ERRCODE='23514';
    END IF;
    IF NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
      RAISE EXCEPTION 'Decision time is database-derived' USING ERRCODE='23514';
    END IF;
    NEW.decided_at:=observed;
    IF NEW.status='EXPIRED' THEN
      IF NEW.expires_at>observed OR NEW.decided_by_membership_id IS NOT NULL THEN
        RAISE EXCEPTION 'Request has not expired' USING ERRCODE='23514';
      END IF;
    ELSE
      SELECT * INTO decision FROM workspace_memberships WHERE id=NEW.decided_by_membership_id AND workspace_id=NEW.workspace_id;
      IF decision.id IS NULL OR decision.status<>'ACTIVE' OR NOT EXISTS(SELECT FROM users WHERE id=decision.user_id AND status='active') OR
        (NEW.status IN ('APPROVED','REJECTED') AND decision.role<>'OWNER') OR
        (NEW.status='CANCELLED' AND decision.id<>NEW.source_membership_id) THEN
        RAISE EXCEPTION 'Invalid transfer decision actor' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  IF NEW.status IN ('REQUESTED','APPROVED') AND (
    w.lifecycle_status<>'ACTIVE' OR l.status='retired' OR l.responsible_membership_id<>NEW.source_membership_id OR
    l.revision<>NEW.expected_listing_revision OR w.ownership_revision<>NEW.expected_ownership_revision OR
    src.id IS NULL OR dst.id IS NULL OR src.role<>'AGENT' OR dst.role<>'AGENT' OR
    src.status<>'ACTIVE' OR dst.status<>'ACTIVE' OR
    src.revision<>NEW.expected_source_revision OR dst.revision<>NEW.expected_target_revision OR
    NOT EXISTS(SELECT FROM users WHERE id=src.user_id AND status='active') OR
    NOT EXISTS(SELECT FROM users WHERE id=dst.user_id AND status='active') OR NEW.expires_at<=observed
  ) THEN RAISE EXCEPTION 'Transfer request is stale or ineligible' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER listing_transfer_request_guard BEFORE INSERT OR UPDATE OR DELETE ON listing_transfer_requests
  FOR EACH ROW EXECUTE FUNCTION guard_listing_transfer_request();

CREATE FUNCTION check_listing_transfer_completion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_workspace_tenant(NEW.workspace_id);
  IF NEW.status='APPROVED' AND NOT EXISTS(SELECT FROM listing_assignment_transitions e
    WHERE e.transfer_request_id=NEW.id AND e.workspace_id=NEW.workspace_id AND e.listing_id=NEW.listing_id
      AND e.previous_membership_id=NEW.source_membership_id AND e.new_membership_id=NEW.target_membership_id
      AND e.reason='APPROVED_TRANSFER' AND e.approved_by_membership_id=NEW.decided_by_membership_id) THEN
    RAISE EXCEPTION 'Approved request requires atomic assignment transition' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER listing_transfer_completion AFTER UPDATE ON listing_transfer_requests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_listing_transfer_completion();

-- Preserve the verification evidence/queue invariants while replacing the old
-- actor-equals-owner-user check. Actor attribution remains the real global User.
DO $$ DECLARE s text:=current_schema(); f record; old_guard text;
BEGIN
  SELECT p.oid,p.prosrc INTO STRICT f FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname=s AND p.proname='guard_verification_decision';
  old_guard:='IF NEW.actor_user_id IS DISTINCT FROM (SELECT provider_id FROM listings WHERE id = listing_id) THEN RAISE EXCEPTION ''Only the listing provider can decide verification'' USING ERRCODE = ''23514''; END IF;';
  IF position(old_guard IN f.prosrc)=0 THEN RAISE EXCEPTION 'Unexpected verification guard baseline'; END IF;
  EXECUTE replace(pg_get_functiondef(f.oid),old_guard,format(
    'IF NOT EXISTS(SELECT FROM %I.listings l JOIN %I.workspace_memberships m ON m.workspace_id=l.workspace_id
      JOIN %I.users u ON u.id=m.user_id WHERE l.id=listing_id AND l.workspace_id=%I.current_workspace_id()
      AND m.user_id=NEW.actor_user_id AND m.status=''ACTIVE'' AND u.status=''active''
      AND (m.role=''OWNER'' OR m.id=l.responsible_membership_id)) THEN
      RAISE EXCEPTION ''Current workspace listing authority required'' USING ERRCODE=''23514''; END IF;',s,s,s,s));
END $$;

DO $$ DECLARE s text:=current_schema(); f record; source text; token text;
  objects text[]:=ARRAY['listings','workspace_memberships','provider_workspaces','users',
    'listing_assignment_transitions','listing_transfer_requests','assert_workspace_tenant'];
BEGIN
  FOR f IN SELECT p.oid,p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=s AND p.proname IN
    ('guard_listing_transfer_request','check_listing_transfer_completion') LOOP
    source:='';
    FOR token IN SELECT(m)[1] FROM regexp_matches(f.prosrc,
      $rx$('(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_][A-Za-z_0-9]*|.)$rx$,'gs') m LOOP
      IF trim(both '"' FROM token)=ANY(objects) AND left(token,1)<>'''' THEN
        source:=source||format('%I.%s',s,token);
      ELSE source:=source||token; END IF;
    END LOOP;
    EXECUTE replace(pg_get_functiondef(f.oid),f.prosrc,source);
    EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',f.oid::regprocedure,s);
    EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER',f.oid::regprocedure);
    EXECUTE format('ALTER FUNCTION %s OWNER TO renyqo_workspace_invariants',f.oid::regprocedure);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,renyqo_workspace_runtime',f.oid::regprocedure);
  END LOOP;
END $$;

-- An explicit worker-only purpose seam resolves one canonical viewing target;
-- the worker installs one tenant scope and rechecks deadlines under root locks.
DO $$ DECLARE s text:=current_schema();
BEGIN
  EXECUTE format('GRANT SELECT(id,application_id,pending_proposal_id) ON %I.viewing_workflows TO renyqo_applicant_listing_resolver',s);
  EXECUTE format('GRANT SELECT(id,workflow_id,resolution) ON %I.viewing_proposals TO renyqo_applicant_listing_resolver',s);
  EXECUTE format('GRANT SELECT(viewing_id,workflow_id,interest_state) ON %I.viewing_appointments TO renyqo_applicant_listing_resolver',s);
  EXECUTE format($sql$
    CREATE FUNCTION %1$I.resolve_viewing_expiry_listing(application_selector uuid,target_selector uuid,target_kind text)
    RETURNS TABLE(listing_id uuid,workspace_id uuid) LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
      SELECT r.listing_id,r.workspace_id FROM %1$I.applications a
      JOIN %1$I.listing_tenant_routes r ON r.listing_id=a.listing_id
      JOIN %1$I.viewing_workflows w ON w.application_id=a.id
      WHERE a.id=application_selector AND (
        (target_kind='proposal' AND w.pending_proposal_id=target_selector AND EXISTS(
          SELECT FROM %1$I.viewing_proposals p WHERE p.id=target_selector AND p.workflow_id=w.id AND p.resolution='pending')) OR
        (target_kind='interest' AND EXISTS(SELECT FROM %1$I.viewing_appointments v
          WHERE v.viewing_id=target_selector AND v.workflow_id=w.id AND v.interest_state='pending')))
    $fn$;
  $sql$,s);
  EXECUTE format('ALTER FUNCTION %I.resolve_viewing_expiry_listing(uuid,uuid,text) OWNER TO renyqo_applicant_listing_resolver',s);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.resolve_viewing_expiry_listing(uuid,uuid,text) FROM PUBLIC',s);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.resolve_viewing_expiry_listing(uuid,uuid,text) TO renyqo_workspace_runtime',s);
END $$;

-- Profile edits preserve atomic cross-workspace eligibility/queue maintenance.
-- Only this non-login function owner can use these relationship-bounded policies.
-- The application login receives EXECUTE, never role membership or these policies.
DO $$ DECLARE s text:=current_schema(); predicate text;
BEGIN
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='renyqo_profile_revalidation') THEN
    CREATE ROLE renyqo_profile_revalidation NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
  END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='renyqo_profile_revalidation'
    AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb)) OR
    EXISTS(SELECT FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='renyqo_profile_revalidation')) THEN
    RAISE EXCEPTION 'Unsafe profile revalidation helper role';
  END IF;
  EXECUTE format('GRANT renyqo_profile_revalidation TO %I',current_user);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO renyqo_profile_revalidation',s);
  EXECUTE format('GRANT SELECT(id,listing_id,applicant_id,status) ON %I.applications TO renyqo_profile_revalidation',s);
  EXECUTE format('GRANT SELECT ON %I.listing_tenant_routes TO renyqo_profile_revalidation',s);
  EXECUTE format('GRANT SELECT(id,lifecycle_status),UPDATE(id) ON %I.provider_workspaces TO renyqo_profile_revalidation',s);
  EXECUTE format('GRANT SELECT,UPDATE(id) ON %I.listings TO renyqo_profile_revalidation',s);
  predicate:=format('EXISTS(SELECT FROM %I.applications a WHERE a.listing_id=listings.id AND a.applicant_id=nullif(current_setting(''app.profile_revalidation_user'',true),'''')::uuid)',s);
  EXECUTE format('CREATE POLICY profile_listing_read ON %I.listings FOR SELECT TO renyqo_profile_revalidation USING(%s)',s,predicate);
  EXECUTE format('CREATE POLICY profile_listing_lock ON %I.listings FOR UPDATE TO renyqo_profile_revalidation USING(%s) WITH CHECK(false)',s,predicate);
  predicate:=format('EXISTS(SELECT FROM %I.listing_tenant_routes r JOIN %I.applications a ON a.listing_id=r.listing_id WHERE r.workspace_id=provider_workspaces.id AND a.applicant_id=nullif(current_setting(''app.profile_revalidation_user'',true),'''')::uuid)',s,s);
  EXECUTE format('CREATE POLICY profile_workspace_read ON %I.provider_workspaces FOR SELECT TO renyqo_profile_revalidation USING(%s)',s,predicate);
  EXECUTE format($sql$
    CREATE FUNCTION %1$I.lock_profile_revalidation_listings(authenticated_applicant uuid)
    RETURNS TABLE(id uuid,status text,"minimumHouseholdNetIncome" double precision,
      "suitableForPeopleCount" integer,"petsPolicy" text,"smokingPolicy" text,
      "schufaRequired" boolean,"incomeProofRequired" boolean)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,%1$I,pg_temp AS $fn$
    DECLARE previous text:=current_setting('app.profile_revalidation_user',true);
    BEGIN
      IF nullif(current_setting('app.workspace_id',true),'') IS NOT NULL THEN
        RAISE EXCEPTION 'Profile revalidation cannot enter an ordinary tenant scope' USING ERRCODE='42501';
      END IF;
      PERFORM set_config('app.profile_revalidation_user',authenticated_applicant::text,true);
      PERFORM w.id FROM %1$I.provider_workspaces w WHERE EXISTS(
        SELECT FROM %1$I.listing_tenant_routes r JOIN %1$I.applications a ON a.listing_id=r.listing_id
        WHERE r.workspace_id=w.id AND a.applicant_id=authenticated_applicant AND a.status IN('active','waiting'))
        ORDER BY w.id FOR SHARE OF w;
      IF EXISTS(SELECT FROM %1$I.provider_workspaces w WHERE w.lifecycle_status<>'ACTIVE' AND EXISTS(
        SELECT FROM %1$I.listing_tenant_routes r JOIN %1$I.applications a ON a.listing_id=r.listing_id
        WHERE r.workspace_id=w.id AND a.applicant_id=authenticated_applicant AND a.status IN('active','waiting'))) THEN
        RAISE EXCEPTION 'Profile revalidation requires operational workspaces' USING ERRCODE='23514';
      END IF;
      RETURN QUERY SELECT l.id,upper(l.status::text),l.minimum_household_net_income,l.suitable_for_people_count,
        upper(l.pets_policy::text),upper(l.smoking_policy::text),l.schufa_required,l.income_proof_required
        FROM %1$I.listings l WHERE EXISTS(SELECT FROM %1$I.applications a WHERE a.listing_id=l.id
          AND a.applicant_id=authenticated_applicant AND a.status IN('active','waiting'))
        ORDER BY l.id FOR UPDATE OF l;
      PERFORM set_config('app.profile_revalidation_user',coalesce(previous,''),true);
    END $fn$;
  $sql$,s);
  EXECUTE format('ALTER FUNCTION %I.lock_profile_revalidation_listings(uuid) OWNER TO renyqo_profile_revalidation',s);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.lock_profile_revalidation_listings(uuid) FROM PUBLIC',s);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.lock_profile_revalidation_listings(uuid) TO renyqo_workspace_runtime',s);
END $$;

COMMIT;

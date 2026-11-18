BEGIN;
LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT FROM users GROUP BY lower(btrim(email)) HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Resolve canonical email collisions before invitation cutover';
  END IF;
END $$;
UPDATE users SET email=lower(btrim(email)) WHERE email<>lower(btrim(email));
CREATE UNIQUE INDEX users_canonical_email_key ON users(lower(btrim(email)));
ALTER TABLE users ADD CONSTRAINT users_canonical_email CHECK(email=lower(btrim(email)));

CREATE TABLE email_verification_challenges (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  email text NOT NULL, token_hash varchar(64) NOT NULL UNIQUE,
  auth_version integer NOT NULL CHECK(auth_version>0), session_id text NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz(3) NOT NULL, used_at timestamptz(3),
  CHECK(expires_at>created_at)
);
CREATE INDEX email_verification_user_created ON email_verification_challenges(user_id,created_at);
ALTER TABLE workspace_seat_reservations ADD CONSTRAINT seat_reservation_id_workspace UNIQUE(id,workspace_id);

CREATE TYPE "WorkspaceInvitationStatus" AS ENUM('PENDING','ACCEPTED','REVOKED','EXPIRED');
CREATE TABLE workspace_invitations (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES provider_workspaces(id) ON DELETE RESTRICT,
  email text NOT NULL CHECK(email=lower(btrim(email))),
  role "WorkspaceMembershipRole" NOT NULL DEFAULT 'AGENT' CHECK(role='AGENT'),
  created_by_membership_id uuid NOT NULL,
  reservation_id uuid NOT NULL UNIQUE,
  token_hash varchar(64) NOT NULL UNIQUE, generation integer NOT NULL DEFAULT 1 CHECK(generation>0),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  issuer_membership_revision integer NOT NULL CHECK(issuer_membership_revision>0),
  issuer_auth_version integer NOT NULL CHECK(issuer_auth_version>0),
  ownership_revision integer NOT NULL CHECK(ownership_revision>0),
  status "WorkspaceInvitationStatus" NOT NULL DEFAULT 'PENDING',
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  issued_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz(3) NOT NULL,
  accepted_at timestamptz(3), revoked_at timestamptz(3), expired_at timestamptz(3),
  accepted_membership_id uuid, accepted_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  acceptance_kind varchar(16) CHECK(acceptance_kind IN('CREATED','ALREADY_MEMBER')),
  delivery_status varchar(12) NOT NULL DEFAULT 'UNKNOWN' CHECK(delivery_status IN('UNKNOWN','ACCEPTED','FAILED')),
  UNIQUE(id,workspace_id), UNIQUE(reservation_id,workspace_id),
  FOREIGN KEY(created_by_membership_id,workspace_id) REFERENCES workspace_memberships(id,workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY(accepted_membership_id,workspace_id) REFERENCES workspace_memberships(id,workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY(reservation_id,workspace_id) REFERENCES workspace_seat_reservations(id,workspace_id) ON DELETE RESTRICT,
  CHECK(expires_at>created_at AND issued_at>=created_at),
  CHECK((status='ACCEPTED' AND accepted_at IS NOT NULL AND accepted_membership_id IS NOT NULL AND accepted_user_id IS NOT NULL AND acceptance_kind IS NOT NULL AND revoked_at IS NULL AND expired_at IS NULL)
    OR (status<>'ACCEPTED' AND accepted_at IS NULL AND accepted_membership_id IS NULL AND accepted_user_id IS NULL AND acceptance_kind IS NULL
      AND ((status='PENDING' AND revoked_at IS NULL AND expired_at IS NULL) OR (status='REVOKED' AND revoked_at IS NOT NULL AND expired_at IS NULL) OR (status='EXPIRED' AND expired_at IS NOT NULL AND revoked_at IS NULL))))
);
CREATE UNIQUE INDEX workspace_invitation_pending_email ON workspace_invitations(workspace_id,email) WHERE status='PENDING';
CREATE UNIQUE INDEX workspace_invitation_admitted_member ON workspace_invitations(accepted_membership_id) WHERE acceptance_kind='CREATED';
CREATE INDEX workspace_invitation_page ON workspace_invitations(workspace_id,created_at,id);

CREATE TABLE workspace_invitation_commands (
  workspace_id uuid NOT NULL, command_id uuid NOT NULL, invitation_id uuid NOT NULL,
  kind varchar(12) NOT NULL CHECK(kind IN('CREATE','RESEND','REVOKE','ACCEPT','EXPIRE')),
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  input_hash varchar(64) NOT NULL, result_revision integer NOT NULL,
  occurred_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,command_id),
  FOREIGN KEY(invitation_id,workspace_id) REFERENCES workspace_invitations(id,workspace_id) ON DELETE RESTRICT
);
DO $$ DECLARE s text:=current_schema(); t text; BEGIN
  FOREACH t IN ARRAY ARRAY['workspace_invitations','workspace_invitation_commands'] LOOP
    EXECUTE format('ALTER TABLE %I.%I OWNER TO renyqo_workspace_owner',s,t);
    EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC,renyqo_workspace_runtime',s,t);
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',s,t);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',s,t);
    EXECUTE format('CREATE POLICY invitation_tenant ON %I.%I TO renyqo_workspace_runtime,renyqo_workspace_invariants USING(workspace_id=(SELECT %I.current_workspace_id())) WITH CHECK(workspace_id=(SELECT %I.current_workspace_id()))',s,t,s,s);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I.%I TO renyqo_workspace_runtime,renyqo_workspace_invariants',s,t);
  END LOOP;
  EXECUTE format('CREATE POLICY invitation_fence ON %I.workspace_invitation_commands AS RESTRICTIVE TO renyqo_workspace_runtime,renyqo_workspace_invariants USING(workspace_id=(SELECT %I.current_workspace_id())) WITH CHECK(workspace_id=(SELECT %I.current_workspace_id()))',s,s,s);
  EXECUTE format('CREATE POLICY invitation_fence ON %I.workspace_invitations AS RESTRICTIVE TO renyqo_workspace_runtime,renyqo_workspace_invariants USING(workspace_id=(SELECT %I.current_workspace_id()) OR (current_user=''renyqo_workspace_invariants'' AND token_hash=current_setting(''app.invitation_hash'',true) AND email=current_setting(''app.invitation_email'',true) AND current_setting(''app.invitation_xid'',true)=pg_current_xact_id()::text)) WITH CHECK(workspace_id=(SELECT %I.current_workspace_id()))',s,s,s);
  EXECUTE format('CREATE POLICY invitation_lookup ON %I.workspace_invitations FOR SELECT TO renyqo_workspace_invariants USING(token_hash=current_setting(''app.invitation_hash'',true) AND email=current_setting(''app.invitation_email'',true) AND current_setting(''app.invitation_xid'',true)=pg_current_xact_id()::text)',s);
  EXECUTE format('REVOKE UPDATE ON %I.workspace_invitation_commands FROM renyqo_workspace_runtime,renyqo_workspace_invariants',s);
  EXECUTE format('REVOKE ALL ON %I.email_verification_challenges FROM PUBLIC,renyqo_workspace_runtime',s);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I.email_verification_challenges TO renyqo_workspace_runtime',s);
END $$;
COMMIT;

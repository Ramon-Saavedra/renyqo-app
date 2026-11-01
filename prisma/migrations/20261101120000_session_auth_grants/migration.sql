-- Intentionally no backfill: pre-grant sessions must authenticate again.
CREATE TABLE "session_auth_grants" (
    "sid" VARCHAR NOT NULL,
    "user_id" UUID NOT NULL,
    "auth_version" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "session_auth_grants_pkey" PRIMARY KEY ("sid")
);

CREATE INDEX "session_auth_grants_user_id_idx" ON "session_auth_grants"("user_id");

ALTER TABLE "session_auth_grants" ADD CONSTRAINT "session_auth_grants_sid_fkey"
    FOREIGN KEY ("sid") REFERENCES "user_sessions"("sid") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "session_auth_grants" ADD CONSTRAINT "session_auth_grants_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

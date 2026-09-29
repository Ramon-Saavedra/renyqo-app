CREATE TYPE "ApplicationActivityType" AS ENUM ('application_submitted', 'application_promoted_to_active', 'application_withdrawn', 'application_rejected', 'application_restored', 'application_accepted');

CREATE TYPE "ApplicationActivityActorType" AS ENUM ('system', 'applicant', 'provider');

CREATE TYPE "ApplicationActivityVisibility" AS ENUM ('provider', 'applicant', 'both', 'internal');

CREATE TABLE "application_activities" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "type" "ApplicationActivityType" NOT NULL,
    "actor_user_id" UUID,
    "actor_type" "ApplicationActivityActorType" NOT NULL,
    "visibility" "ApplicationActivityVisibility" NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB,

    CONSTRAINT "application_activities_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "application_activities_application_id_occurred_at_id_idx" ON "application_activities"("application_id", "occurred_at", "id");

CREATE INDEX "application_activities_application_id_visibility_occurred_at_id_idx" ON "application_activities"("application_id", "visibility", "occurred_at", "id");

ALTER TABLE "application_activities" ADD CONSTRAINT "application_activities_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "application_activities" ADD CONSTRAINT "application_activities_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

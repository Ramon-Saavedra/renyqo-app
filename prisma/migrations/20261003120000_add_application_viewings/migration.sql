CREATE TYPE "ApplicationViewingStatus" AS ENUM ('proposed', 'accepted', 'declined', 'change_requested', 'cancelled', 'completed', 'no_show', 'superseded');

CREATE TYPE "ViewingOutcome" AS ENUM ('completed', 'no_show');

CREATE TYPE "ViewingInterest" AS ENUM ('still_interested', 'not_interested');



ALTER TYPE "ApplicationActivityType" ADD VALUE 'viewing_proposed';
ALTER TYPE "ApplicationActivityType" ADD VALUE 'viewing_accepted';
ALTER TYPE "ApplicationActivityType" ADD VALUE 'viewing_declined';
ALTER TYPE "ApplicationActivityType" ADD VALUE 'viewing_change_requested';
ALTER TYPE "ApplicationActivityType" ADD VALUE 'viewing_rescheduled';
ALTER TYPE "ApplicationActivityType" ADD VALUE 'viewing_cancelled';
ALTER TYPE "ApplicationActivityType" ADD VALUE 'viewing_completed';
ALTER TYPE "ApplicationActivityType" ADD VALUE 'viewing_no_show';
ALTER TYPE "ApplicationActivityType" ADD VALUE 'viewing_outcome_corrected';
ALTER TYPE "ApplicationActivityType" ADD VALUE 'viewing_interest_confirmed';
ALTER TYPE "ApplicationActivityType" ADD VALUE 'viewing_interest_declined';

CREATE TABLE "application_viewings" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "round" INTEGER NOT NULL,
    "status" "ApplicationViewingStatus" NOT NULL DEFAULT 'proposed',
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "time_zone" VARCHAR(100) NOT NULL,
    "provider_note" VARCHAR(500),
    "accepted_at" TIMESTAMPTZ(3),
    "declined_at" TIMESTAMPTZ(3),
    "change_requested_at" TIMESTAMPTZ(3),
    "change_request_message" VARCHAR(500),
    "cancelled_at" TIMESTAMPTZ(3),
    "superseded_at" TIMESTAMPTZ(3),
    "request_key" UUID NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "application_viewings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "application_viewing_outcomes" (
    "id" UUID NOT NULL,
    "viewing_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "outcome" "ViewingOutcome" NOT NULL,
    "correction_reason" VARCHAR(500),
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_viewing_outcomes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "application_viewing_interests" (
    "id" UUID NOT NULL,
    "viewing_id" UUID NOT NULL,
    "interest" "ViewingInterest" NOT NULL,
    "responded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_viewing_interests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "application_viewings_application_id_status_round_idx" ON "application_viewings"("application_id", "status", "round");

CREATE UNIQUE INDEX "application_viewings_application_id_round_key" ON "application_viewings"("application_id", "round");

CREATE UNIQUE INDEX "application_viewings_application_id_request_key_key" ON "application_viewings"("application_id", "request_key");

CREATE UNIQUE INDEX "application_viewing_outcomes_viewing_id_revision_key" ON "application_viewing_outcomes"("viewing_id", "revision");

CREATE UNIQUE INDEX "application_viewing_interests_viewing_id_key" ON "application_viewing_interests"("viewing_id");

ALTER TABLE "application_viewings" ADD CONSTRAINT "application_viewings_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "application_viewing_outcomes" ADD CONSTRAINT "application_viewing_outcomes_viewing_id_fkey" FOREIGN KEY ("viewing_id") REFERENCES "application_viewings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "application_viewing_interests" ADD CONSTRAINT "application_viewing_interests_viewing_id_fkey" FOREIGN KEY ("viewing_id") REFERENCES "application_viewings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "application_viewings_one_unresolved" ON "application_viewings" ("application_id") WHERE "status" IN ('proposed', 'accepted');

ALTER TABLE "application_viewings" ADD CONSTRAINT "viewing_round_positive" CHECK ("round" > 0),
ADD CONSTRAINT "viewing_duration" CHECK ("ends_at" - "starts_at" BETWEEN INTERVAL '5 minutes' AND INTERVAL '240 minutes'),
ADD CONSTRAINT "viewing_status_dates" CHECK (
  ("declined_at" IS NOT NULL) = ("status" = 'declined') AND
  ("change_requested_at" IS NOT NULL) = ("status" = 'change_requested') AND
  ("cancelled_at" IS NOT NULL) = ("status" = 'cancelled') AND
  ("superseded_at" IS NOT NULL) = ("status" = 'superseded') AND
  ("status" <> 'proposed' OR "accepted_at" IS NULL) AND
  ("status" NOT IN ('accepted', 'completed', 'no_show') OR "accepted_at" IS NOT NULL) AND
  ("change_request_message" IS NULL OR "status" = 'change_requested')
),
ADD CONSTRAINT "viewing_closing_dates" CHECK (num_nonnulls("declined_at", "change_requested_at", "cancelled_at", "superseded_at") <= 1);

ALTER TABLE "application_viewing_outcomes" ADD CONSTRAINT "viewing_outcome_revision" CHECK (
  ("revision" = 1 AND "correction_reason" IS NULL) OR
  ("revision" = 2 AND length(btrim("correction_reason")) BETWEEN 1 AND 500 AND "correction_reason" IS NOT NULL)
);

CREATE FUNCTION "guard_viewing_decision"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  original_outcome "ViewingOutcome";
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Viewing decisions are append-only' USING ERRCODE = '23514';
  END IF;
  UPDATE "application_viewings" SET "updated_at" = "updated_at" WHERE "id" = NEW."viewing_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Viewing does not exist' USING ERRCODE = '23503';
  END IF;
  IF TG_TABLE_NAME = 'application_viewing_outcomes' THEN
    IF NEW."revision" = 2 THEN
      SELECT "outcome" INTO original_outcome FROM "application_viewing_outcomes"
      WHERE "viewing_id" = NEW."viewing_id" AND "revision" = 1;
      IF NOT FOUND OR original_outcome = NEW."outcome" THEN
        RAISE EXCEPTION 'Correction requires a preceding different outcome' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "viewing_outcome_append_only" BEFORE INSERT OR UPDATE OR DELETE
ON "application_viewing_outcomes" FOR EACH ROW EXECUTE FUNCTION "guard_viewing_decision"();

CREATE TRIGGER "viewing_interest_final" BEFORE INSERT OR UPDATE OR DELETE
ON "application_viewing_interests" FOR EACH ROW EXECUTE FUNCTION "guard_viewing_decision"();

CREATE FUNCTION "check_viewing_effective_outcome"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_id UUID;
  effective_status "ApplicationViewingStatus";
  latest_outcome "ViewingOutcome";
BEGIN
  IF TG_TABLE_NAME = 'application_viewings' THEN
    target_id := NEW."id";
  ELSE
    target_id := NEW."viewing_id";
  END IF;
  SELECT "status" INTO effective_status FROM "application_viewings" WHERE "id" = target_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT "outcome" INTO latest_outcome FROM "application_viewing_outcomes"
  WHERE "viewing_id" = target_id ORDER BY "revision" DESC LIMIT 1;
  IF (effective_status IN ('completed', 'no_show') AND
      (latest_outcome IS NULL OR effective_status::text <> latest_outcome::text)) OR
     (effective_status NOT IN ('completed', 'no_show') AND latest_outcome IS NOT NULL) THEN
    RAISE EXCEPTION 'Viewing status must match its latest outcome decision' USING ERRCODE = '23514';
  END IF;
  IF effective_status <> 'completed' AND EXISTS (
    SELECT 1 FROM "application_viewing_interests" WHERE "viewing_id" = target_id
  ) THEN
    RAISE EXCEPTION 'Interest requires effective completed outcome' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "viewing_effective_outcome" AFTER INSERT OR UPDATE
ON "application_viewings" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "check_viewing_effective_outcome"();

CREATE CONSTRAINT TRIGGER "viewing_outcome_effective_status" AFTER INSERT
ON "application_viewing_outcomes" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "check_viewing_effective_outcome"();

CREATE CONSTRAINT TRIGGER "viewing_interest_completed" AFTER INSERT
ON "application_viewing_interests" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "check_viewing_effective_outcome"();

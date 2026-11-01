-- CreateEnum
CREATE TYPE "ProfileEligibilityResult" AS ENUM ('MATCH', 'NO_MATCH', 'MATCH_WITH_OBSERVATIONS', 'INSUFFICIENT_INFORMATION');

-- CreateEnum
CREATE TYPE "ProfileEligibilityCriterion" AS ENUM ('PROFILE', 'INCOME', 'HOUSEHOLD_SIZE', 'PETS', 'SMOKING', 'SCHUFA_DECLARATION', 'INCOME_PROOF_DECLARATION');

-- CreateEnum
CREATE TYPE "ProfileEligibilityOutcome" AS ENUM ('PASS', 'FAIL', 'UNKNOWN', 'OBSERVATION', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "ProfileEligibilityCode" AS ENUM ('profile_not_available', 'household_income_not_available', 'household_income_below_requirement', 'household_size_not_available', 'household_size_exceeds_requirement', 'pets_not_allowed', 'smoking_not_allowed', 'pets_information_not_available', 'smoking_information_not_available', 'pets_by_arrangement', 'smoking_by_arrangement', 'schufa_declaration_pending', 'schufa_declared_not_verified', 'income_proof_declaration_pending', 'income_proof_declared_not_verified');

-- CreateEnum
CREATE TYPE "EligibilityAssessmentTrigger" AS ENUM ('APPLICATION_CREATED', 'CRITERIA_CHANGED', 'PROFILE_CHANGED', 'RESTORE', 'PROMOTION');

-- CreateEnum
CREATE TYPE "CriteriaRevisionSource" AS ENUM ('NATIVE', 'LEGACY_BASELINE');

-- CreateTable
CREATE TABLE "listing_criteria_revisions" (
    "id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "source" "CriteriaRevisionSource" NOT NULL,
    "actor_user_id" UUID,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "minimum_household_net_income" DOUBLE PRECISION,
    "suitable_for_people_count" INTEGER,
    "pets_policy" "PetsPolicy",
    "smoking_policy" "SmokingPolicy",
    "schufa_required" BOOLEAN NOT NULL,
    "income_proof_required" BOOLEAN NOT NULL,

    CONSTRAINT "listing_criteria_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_eligibility_assessments" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "criteria_revision_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "evaluator_version" VARCHAR(80) NOT NULL,
    "trigger" "EligibilityAssessmentTrigger" NOT NULL,
    "actor_user_id" UUID,
    "evaluated_at" TIMESTAMPTZ(3) NOT NULL,
    "result" "ProfileEligibilityResult" NOT NULL,
    "profile_present" BOOLEAN NOT NULL,
    "household_net_income" DOUBLE PRECISION,
    "household_size" INTEGER,
    "has_pets" BOOLEAN,
    "is_smoker" BOOLEAN,
    "schufa_available" BOOLEAN,
    "income_proof_available" BOOLEAN,

    CONSTRAINT "application_eligibility_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_eligibility_checks" (
    "assessment_id" UUID NOT NULL,
    "criterion" "ProfileEligibilityCriterion" NOT NULL,
    "outcome" "ProfileEligibilityOutcome" NOT NULL,
    "code" "ProfileEligibilityCode",

    CONSTRAINT "application_eligibility_checks_pkey" PRIMARY KEY ("assessment_id","criterion")
);

-- CreateIndex
CREATE UNIQUE INDEX "listing_criteria_revisions_listing_id_revision_key" ON "listing_criteria_revisions"("listing_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "listing_criteria_revisions_id_listing_id_key" ON "listing_criteria_revisions"("id", "listing_id");

-- CreateIndex
CREATE INDEX "application_eligibility_assessments_listing_id_evaluated_at_idx" ON "application_eligibility_assessments"("listing_id", "evaluated_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "application_eligibility_assessments_application_id_revision_key" ON "application_eligibility_assessments"("application_id", "revision");

-- AddForeignKey
ALTER TABLE "listing_criteria_revisions" ADD CONSTRAINT "listing_criteria_revisions_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_criteria_revisions" ADD CONSTRAINT "listing_criteria_revisions_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_eligibility_assessments" ADD CONSTRAINT "application_eligibility_assessments_application_id_listing_fkey" FOREIGN KEY ("application_id", "listing_id") REFERENCES "applications"("id", "listing_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_eligibility_assessments" ADD CONSTRAINT "application_eligibility_assessments_criteria_revision_id_l_fkey" FOREIGN KEY ("criteria_revision_id", "listing_id") REFERENCES "listing_criteria_revisions"("id", "listing_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_eligibility_assessments" ADD CONSTRAINT "application_eligibility_assessments_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_eligibility_checks" ADD CONSTRAINT "application_eligibility_checks_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "application_eligibility_assessments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Legacy applications receive no fabricated application-time assessment.
CREATE UNIQUE INDEX application_eligibility_initial_once ON application_eligibility_assessments(application_id) WHERE trigger = 'APPLICATION_CREATED';
ALTER TABLE listing_criteria_revisions ADD CONSTRAINT criteria_revision_positive CHECK (revision > 0 AND schema_version > 0);
ALTER TABLE application_eligibility_assessments ADD CONSTRAINT assessment_revision_positive CHECK (revision > 0 AND (trigger <> 'APPLICATION_CREATED' OR revision = 1));
ALTER TABLE application_eligibility_checks ADD CONSTRAINT assessment_check_code CHECK ((outcome IN ('PASS','NOT_APPLICABLE') AND code IS NULL) OR (outcome IN ('FAIL','UNKNOWN','OBSERVATION') AND code IS NOT NULL));

CREATE FUNCTION reject_eligibility_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Eligibility history is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER criteria_revision_immutable BEFORE UPDATE OR DELETE ON listing_criteria_revisions FOR EACH ROW EXECUTE FUNCTION reject_eligibility_history_mutation();
CREATE TRIGGER eligibility_assessment_immutable BEFORE UPDATE OR DELETE ON application_eligibility_assessments FOR EACH ROW EXECUTE FUNCTION reject_eligibility_history_mutation();
CREATE TRIGGER eligibility_check_immutable BEFORE UPDATE OR DELETE ON application_eligibility_checks FOR EACH ROW EXECUTE FUNCTION reject_eligibility_history_mutation();

CREATE FUNCTION order_criteria_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected integer;
BEGIN
  PERFORM 1 FROM listings WHERE id=NEW.listing_id FOR UPDATE;
  SELECT COALESCE(MAX(revision),0)+1 INTO expected FROM listing_criteria_revisions WHERE listing_id=NEW.listing_id;
  IF NEW.revision <> expected THEN RAISE EXCEPTION 'Criteria revision out of order' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER criteria_revision_order BEFORE INSERT ON listing_criteria_revisions FOR EACH ROW EXECUTE FUNCTION order_criteria_revision();

CREATE FUNCTION order_eligibility_assessment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected integer; current_criteria uuid;
BEGIN
  PERFORM 1 FROM listings WHERE id=NEW.listing_id FOR UPDATE;
  SELECT COALESCE(MAX(revision),0)+1 INTO expected FROM application_eligibility_assessments WHERE application_id=NEW.application_id;
  SELECT id INTO current_criteria FROM listing_criteria_revisions WHERE listing_id=NEW.listing_id ORDER BY revision DESC LIMIT 1;
  IF NEW.revision <> expected OR NEW.criteria_revision_id IS DISTINCT FROM current_criteria THEN
    RAISE EXCEPTION 'Assessment revision or criteria is stale' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER eligibility_assessment_order BEFORE INSERT ON application_eligibility_assessments FOR EACH ROW EXECUTE FUNCTION order_eligibility_assessment();

CREATE FUNCTION validate_eligibility_assessment_checks() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total integer; expected "ProfileEligibilityResult";
BEGIN
  SELECT COUNT(*), CASE WHEN bool_or(outcome='FAIL') THEN 'NO_MATCH' WHEN bool_or(outcome='UNKNOWN') THEN 'INSUFFICIENT_INFORMATION' WHEN bool_or(outcome='OBSERVATION') THEN 'MATCH_WITH_OBSERVATIONS' ELSE 'MATCH' END::"ProfileEligibilityResult"
    INTO total, expected FROM application_eligibility_checks WHERE assessment_id=NEW.id;
  IF total <> 7 OR NEW.result <> expected THEN RAISE EXCEPTION 'Incomplete or inconsistent eligibility checks' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER eligibility_assessment_complete AFTER INSERT ON application_eligibility_assessments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_eligibility_assessment_checks();

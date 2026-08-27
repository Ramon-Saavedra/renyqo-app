ALTER TABLE "applicant_profiles" ADD COLUMN "is_smoker" BOOLEAN;

UPDATE "applicant_profiles"
SET "is_smoker" = CASE "smoking_status"
  WHEN 'non_smoker'::"SmokingStatus" THEN FALSE
  WHEN 'smoker'::"SmokingStatus" THEN TRUE
  WHEN 'occasionally'::"SmokingStatus" THEN TRUE
  ELSE NULL
END;

ALTER TYPE "SmokingPolicy" RENAME VALUE 'non_smokers_preferred' TO 'not_allowed';

ALTER TABLE "applicant_profiles"
  DROP COLUMN "pets_note",
  DROP COLUMN "smoking_status";

DROP TYPE "SmokingStatus";

-- Recalculate peopleCount where both detailed counts exist
UPDATE "applicant_profiles"
SET "people_count" = "adults_count" + "children_count"
WHERE "adults_count" IS NOT NULL
  AND "children_count" IS NOT NULL
  AND "people_count" IS DISTINCT FROM "adults_count" + "children_count";

-- Clear all three household counts for ambiguous legacy rows
UPDATE "applicant_profiles"
SET "people_count" = NULL,
    "adults_count" = NULL,
    "children_count" = NULL
WHERE "people_count" IS NOT NULL
  AND ("adults_count" IS NULL OR "children_count" IS NULL);

-- Remove inconsistent rows where detailed counts exist but peopleCount is missing
UPDATE "applicant_profiles"
SET "people_count" = "adults_count" + "children_count"
WHERE "adults_count" IS NOT NULL
  AND "children_count" IS NOT NULL
  AND "people_count" IS NULL;

-- Clear orphaned partial household states where only one detailed count is set
UPDATE "applicant_profiles"
SET "adults_count" = NULL,
    "children_count" = NULL,
    "people_count" = NULL
WHERE ("adults_count" IS NOT NULL AND "children_count" IS NULL)
   OR ("adults_count" IS NULL AND "children_count" IS NOT NULL);

-- Add CHECK constraint enforcing household count invariants
ALTER TABLE "applicant_profiles"
ADD CONSTRAINT "applicant_profiles_household_counts_check"
CHECK (
  ("adults_count" IS NULL AND "children_count" IS NULL AND "people_count" IS NULL)
  OR
  (
    "adults_count" IS NOT NULL
    AND "children_count" IS NOT NULL
    AND "people_count" IS NOT NULL
    AND "adults_count" >= 1
    AND "children_count" >= 0
    AND "people_count" = "adults_count" + "children_count"
  )
);

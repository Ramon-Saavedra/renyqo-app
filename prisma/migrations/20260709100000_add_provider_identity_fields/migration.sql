CREATE TYPE "ProviderType" AS ENUM ('private', 'company');

ALTER TABLE "users"
  ADD COLUMN "provider_type" "ProviderType",
  ADD COLUMN "company_name" TEXT;

ALTER TABLE "users"
  ADD CONSTRAINT "users_provider_company_name_check"
  CHECK (
    (
      "provider_type" = 'company'
      AND "company_name" IS NOT NULL
      AND btrim("company_name") <> ''
    )
    OR (
      "provider_type" IS DISTINCT FROM 'company'
      AND "company_name" IS NULL
    )
  );

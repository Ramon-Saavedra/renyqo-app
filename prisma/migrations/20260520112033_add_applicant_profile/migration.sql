-- CreateEnum
CREATE TYPE "SmokingStatus" AS ENUM ('smoker', 'non_smoker', 'occasionally');

-- CreateTable
CREATE TABLE "applicant_profiles" (
    "id" UUID NOT NULL,
    "applicant_id" UUID NOT NULL,
    "household_net_income" DOUBLE PRECISION,
    "income_proof_available" BOOLEAN,
    "schufa_available" BOOLEAN,
    "people_count" INTEGER,
    "adults_count" INTEGER,
    "children_count" INTEGER,
    "has_pets" BOOLEAN,
    "pets_note" TEXT,
    "smoking_status" "SmokingStatus",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "applicant_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "applicant_profiles_applicant_id_key" ON "applicant_profiles"("applicant_id");

-- AddForeignKey
ALTER TABLE "applicant_profiles" ADD CONSTRAINT "applicant_profiles_applicant_id_fkey" FOREIGN KEY ("applicant_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

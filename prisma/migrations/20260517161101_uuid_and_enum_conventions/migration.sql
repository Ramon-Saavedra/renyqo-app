-- CreateEnum
CREATE TYPE "Role" AS ENUM ('applicant', 'provider', 'admin');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'suspended', 'deleted');

-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('draft', 'published', 'paused', 'archived');

-- CreateEnum
CREATE TYPE "ObjectType" AS ENUM ('apartment', 'house', 'room');

-- CreateEnum
CREATE TYPE "PetsPolicy" AS ENUM ('allowed', 'by_arrangement', 'prefer_not');

-- CreateEnum
CREATE TYPE "SmokingPolicy" AS ENUM ('allowed', 'by_arrangement', 'non_smokers_preferred');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'applicant',
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "accepted_terms_at" TIMESTAMP(3) NOT NULL,
    "accepted_privacy_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listings" (
    "id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "status" "ListingStatus" NOT NULL DEFAULT 'draft',
    "city" TEXT NOT NULL,
    "zip" TEXT NOT NULL,
    "street" TEXT,
    "country" TEXT NOT NULL DEFAULT 'DE',
    "show_exact_address" BOOLEAN NOT NULL DEFAULT false,
    "object_type" "ObjectType" NOT NULL,
    "living_area" DOUBLE PRECISION,
    "rooms" DOUBLE PRECISION,
    "bedrooms" INTEGER,
    "cold_rent" DOUBLE PRECISION,
    "additional_costs" DOUBLE PRECISION,
    "deposit" DOUBLE PRECISION,
    "available_from" TIMESTAMP(3),
    "title" TEXT,
    "short_description" TEXT,
    "photos" TEXT[],
    "minimum_household_net_income" DOUBLE PRECISION,
    "schufa_required" BOOLEAN NOT NULL DEFAULT false,
    "income_proof_required" BOOLEAN NOT NULL DEFAULT false,
    "suitable_for_people_count" INTEGER,
    "pets_policy" "PetsPolicy",
    "smoking_policy" "SmokingPolicy",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "listings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- AddForeignKey
ALTER TABLE "listings" ADD CONSTRAINT "listings_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

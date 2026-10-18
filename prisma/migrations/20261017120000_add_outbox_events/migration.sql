-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "type" VARCHAR(120) NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "application_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatched_at" TIMESTAMP(3),
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "claim_token" UUID,
    "claimed_until" TIMESTAMP(3),
    "last_error" VARCHAR(500),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outbox_events_dispatch_queue_idx" ON "outbox_events"("next_attempt_at", "created_at");

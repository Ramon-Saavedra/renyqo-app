ALTER TYPE "ApplicationActivityType" ADD VALUE 'conversation_opened';
ALTER TYPE "ApplicationActivityType" ADD VALUE 'message_sent';

CREATE TYPE "ConversationSide" AS ENUM ('provider', 'applicant');

CREATE TABLE "application_conversations" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "application_conversations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "application_messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "sender_type" "ConversationSide" NOT NULL,
    "body" VARCHAR(4000) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMP(3),
    CONSTRAINT "application_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "application_messages_sequence_positive" CHECK ("sequence" > 0),
    CONSTRAINT "application_messages_body_nonempty" CHECK (length(btrim("body")) > 0)
);

CREATE UNIQUE INDEX "application_conversations_application_id_key" ON "application_conversations"("application_id");
CREATE UNIQUE INDEX "application_messages_conversation_id_sequence_key" ON "application_messages"("conversation_id", "sequence");
CREATE INDEX "application_messages_conversation_id_sender_type_read_at_idx" ON "application_messages"("conversation_id", "sender_type", "read_at");

ALTER TABLE "application_conversations" ADD CONSTRAINT "application_conversations_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "application_messages" ADD CONSTRAINT "application_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "application_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

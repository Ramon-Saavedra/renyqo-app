import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

type CreatePasswordResetTokenInput = {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
};

type ConsumePasswordResetTokenInput = {
  tokenHash: string;
  passwordHash: string;
  now: Date;
};

type PasswordResetTokenRow = {
  id: string;
  user_id: string;
};

@Injectable()
export class PasswordResetTokensRepository {
  constructor(private readonly prisma: PrismaService) {}

  async invalidateActiveTokensForUser(
    userId: string,
    now: Date,
  ): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "password_reset_tokens"
      SET "used_at" = ${now}
      WHERE "user_id" = ${userId}::uuid
        AND "used_at" IS NULL
        AND "expires_at" > ${now}
    `;
  }

  async create(input: CreatePasswordResetTokenInput): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO "password_reset_tokens" ("user_id", "token_hash", "expires_at")
      VALUES (${input.userId}::uuid, ${input.tokenHash}, ${input.expiresAt})
    `;
  }

  async consumeValidTokenAndUpdatePassword(
    input: ConsumePasswordResetTokenInput,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<PasswordResetTokenRow[]>`
        SELECT "id", "user_id"
        FROM "password_reset_tokens"
        WHERE "token_hash" = ${input.tokenHash}
          AND "used_at" IS NULL
          AND "expires_at" > ${input.now}
        LIMIT 1
        FOR UPDATE
      `;

      const token = rows[0];

      if (!token) {
        return false;
      }

      await tx.$executeRaw`
        UPDATE "users"
        SET "password_hash" = ${input.passwordHash},
            "updated_at" = ${input.now}
        WHERE "id" = ${token.user_id}::uuid
      `;

      await tx.$executeRaw`
        UPDATE "password_reset_tokens"
        SET "used_at" = ${input.now}
        WHERE "id" = ${token.id}::uuid
      `;

      await tx.$executeRaw`
        DELETE FROM "user_sessions"
        WHERE "sess"->'passport'->>'user' = ${token.user_id}
      `;

      return true;
    });
  }
}

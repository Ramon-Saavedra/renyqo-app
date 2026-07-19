import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { EmailModule } from '../email/email.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordResetTokensRepository } from './password-reset-tokens.repository';
import { SessionSerializer } from './serializers/session.serializer';

@Module({
  imports: [
    PassportModule.register({ session: true }),
    UsersModule,
    EmailModule,
  ],
  providers: [AuthService, SessionSerializer, PasswordResetTokensRepository],
  controllers: [AuthController],
})
export class AuthModule {}

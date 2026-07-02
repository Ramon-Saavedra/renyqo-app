import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionSerializer } from './serializers/session.serializer';

@Module({
  imports: [PassportModule.register({ session: true }), UsersModule],
  providers: [AuthService, SessionSerializer],
  controllers: [AuthController],
})
export class AuthModule {}

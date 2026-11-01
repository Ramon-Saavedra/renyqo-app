import { Injectable } from '@nestjs/common';
import passport from 'passport';
import type { Request } from 'express';
import type { SafeUser } from '../../users/types/safe-user.type';
import { UsersService } from '../../users/users.service';

export type SessionAuthentication = { id: string; authVersion: number };

export function isSessionAuthentication(
  value: unknown,
): value is SessionAuthentication {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Record<string, unknown>;
  return (
    typeof snapshot.id === 'string' &&
    typeof snapshot.authVersion === 'number' &&
    Number.isSafeInteger(snapshot.authVersion) &&
    snapshot.authVersion > 0 &&
    snapshot.authVersion <= 2147483647
  );
}

@Injectable()
export class SessionSerializer {
  constructor(private readonly usersService: UsersService) {
    passport.serializeUser<SessionAuthentication>((user, done) =>
      this.serializeUser(user as SafeUser, done),
    );
    // Nest's two-argument wrapper discards request context. Bind validation to the real SID.
    passport.deserializeUser<unknown, Request>((req, snapshot, done) => {
      void this.deserializeUser(req, snapshot, done);
    });
  }

  serializeUser(
    user: SafeUser,
    done: (err: unknown, snapshot?: SessionAuthentication) => void,
  ): void {
    const snapshot = { id: user.id, authVersion: user.authVersion };
    if (!isSessionAuthentication(snapshot)) {
      done(new Error('Missing authentication version'));
      return;
    }
    done(null, snapshot);
  }

  async deserializeUser(
    req: Request,
    snapshot: unknown,
    done: (err: unknown, user: SafeUser | null) => void,
  ): Promise<void> {
    try {
      if (!isSessionAuthentication(snapshot) || !req.sessionID) {
        done(null, null);
        return;
      }
      const user = await this.usersService.findByAuthenticatedSession(
        snapshot.id,
        req.sessionID,
        snapshot.authVersion,
      );
      done(null, user?.authVersion === snapshot.authVersion ? user : null);
    } catch (err) {
      done(err, null);
    }
  }
}

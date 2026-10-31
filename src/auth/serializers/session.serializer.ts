import { Injectable } from '@nestjs/common';
import { PassportSerializer } from '@nestjs/passport';
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
export class SessionSerializer extends PassportSerializer {
  constructor(private readonly usersService: UsersService) {
    super();
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
    snapshot: unknown,
    done: (err: unknown, user: SafeUser | null) => void,
  ): Promise<void> {
    try {
      if (!isSessionAuthentication(snapshot)) {
        done(null, null);
        return;
      }
      const user = await this.usersService.findById(snapshot.id);
      done(null, user?.authVersion === snapshot.authVersion ? user : null);
    } catch (err) {
      done(err, null);
    }
  }
}

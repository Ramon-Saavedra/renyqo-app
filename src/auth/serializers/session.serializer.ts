import { Injectable } from '@nestjs/common';
import { PassportSerializer } from '@nestjs/passport';
import type { SafeUser } from '../../users/types/safe-user.type';
import { UsersService } from '../../users/users.service';

@Injectable()
export class SessionSerializer extends PassportSerializer {
  constructor(private readonly usersService: UsersService) {
    super();
  }

  serializeUser(
    user: SafeUser,
    done: (err: unknown, id: string) => void,
  ): void {
    done(null, user.id);
  }

  async deserializeUser(
    id: string,
    done: (err: unknown, user: SafeUser | null) => void,
  ): Promise<void> {
    try {
      const user = await this.usersService.findById(id);
      done(null, user);
    } catch (err) {
      done(err, null);
    }
  }
}

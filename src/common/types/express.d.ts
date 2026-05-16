import type { SafeUser } from '../users/types/safe-user.type';

declare global {
  namespace Express {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface User extends SafeUser {}
  }
}

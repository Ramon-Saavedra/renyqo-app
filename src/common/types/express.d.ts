import type { SafeUser } from '../users/types/safe-user.type';

declare global {
  namespace Express {
    interface User extends SafeUser {}
  }
}

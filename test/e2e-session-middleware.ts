import type { INestApplication } from '@nestjs/common';
import passport from 'passport';
import { SessionInfrastructureService } from '../src/auth/session/session-infrastructure.service';

/** Production-equivalent session store on the shared Prisma pg pool. */
export function installE2eSessionMiddleware(app: INestApplication): void {
  app.use(app.get(SessionInfrastructureService).createMiddleware());
  app.use(passport.initialize());
  app.use(passport.session());
}

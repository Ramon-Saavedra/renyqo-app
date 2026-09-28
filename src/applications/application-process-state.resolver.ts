import type { Application } from '../generated/prisma/client';

export type ApplicationProcessNextAction = null;
export type ApplicationProcessExpectedActor = null;

export interface ApplicationProcessState {
  readonly lifecycleStatus: Application['status'];
  readonly nextAction: ApplicationProcessNextAction;
  readonly expectedActor: ApplicationProcessExpectedActor;
}

export class ApplicationProcessStateResolver {
  resolve(application: Pick<Application, 'status'>): ApplicationProcessState {
    return {
      lifecycleStatus: application.status,
      nextAction: null,
      expectedActor: null,
    };
  }
}

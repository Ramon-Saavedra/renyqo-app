import { ForbiddenException } from '@nestjs/common';
import type { Application } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { csrfSync } from 'csrf-sync';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const csrf = csrfSync({
  ignoredMethods: ['GET', 'HEAD', 'OPTIONS'],
});

export const generateCsrfToken = csrf.generateToken;
export const revokeCsrfToken = csrf.revokeToken;
export const csrfSynchronisedProtection = csrf.csrfSynchronisedProtection;

export function configureCsrfProtection(
  application: Application,
  frontendUrl: string,
): void {
  application.use(validateRequestOrigin(frontendUrl));
  application.use(csrfSynchronisedProtection);
}

export function validateRequestOrigin(
  frontendUrl: string,
): (req: Request, res: Response, next: NextFunction) => void {
  const expectedOrigin = new URL(frontendUrl).origin;

  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    const origin = getHeaderValue(req.get('origin'));
    const referer = getHeaderValue(req.get('referer'));
    const requestOrigin = origin ?? (referer ? getOrigin(referer) : undefined);

    if (requestOrigin !== expectedOrigin) {
      throw new ForbiddenException('Invalid request origin');
    }

    next();
  };
}

function getHeaderValue(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function getOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

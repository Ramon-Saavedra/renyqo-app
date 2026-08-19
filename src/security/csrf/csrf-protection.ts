import type { Application } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { csrfSync } from 'csrf-sync';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_TOKEN_ERROR = {
  statusCode: 403,
  code: 'CSRF_TOKEN_INVALID',
  message: 'CSRF token is missing, invalid, or expired',
} as const;
const CSRF_ORIGIN_ERROR = {
  statusCode: 403,
  code: 'CSRF_ORIGIN_INVALID',
  message: 'Invalid request origin',
} as const;

const csrf = csrfSync({
  ignoredMethods: ['GET', 'HEAD', 'OPTIONS'],
});

export const generateCsrfToken = csrf.generateToken;
export const revokeCsrfToken = csrf.revokeToken;
export const csrfSynchronisedProtection = csrf.csrfSynchronisedProtection;

function csrfProtectionWithJsonError(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  csrfSynchronisedProtection(req, res, (error?: unknown) => {
    if (error) {
      res.status(CSRF_TOKEN_ERROR.statusCode).json(CSRF_TOKEN_ERROR);
      return;
    }

    next();
  });
}

export function configureCsrfProtection(
  application: Application,
  frontendUrl: string,
): void {
  application.use(validateRequestOrigin(frontendUrl));
  application.use(csrfProtectionWithJsonError);
}

export function validateRequestOrigin(
  frontendUrl: string,
): (req: Request, res: Response, next: NextFunction) => void {
  const expectedOrigin = new URL(frontendUrl).origin;

  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    const origin = getHeaderValue(req.get('origin'));
    const referer = getHeaderValue(req.get('referer'));
    const requestOrigin = origin ?? (referer ? getOrigin(referer) : undefined);

    if (requestOrigin !== expectedOrigin) {
      res.status(CSRF_ORIGIN_ERROR.statusCode).json(CSRF_ORIGIN_ERROR);
      return;
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

# Security

Security is a priority. We follow secure backend practices, validate all inputs, hash passwords, and never store or expose secrets.

Public registration only accepts `applicant` and `provider`. Responses from `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, and `GET /api/v1/auth/me` never include `passwordHash`.

## Session authentication

The API uses session authentication with `express-session`, `connect-pg-simple`, `passport`, and `passport-local`. Passwords are hashed with `bcrypt` and are never stored in plain text.

`SESSION_SECRET` is required and must be at least 32 characters. `FRONTEND_URL` is required in production. It is the allowed frontend origin for CORS and CSRF Origin/Referer validation. Production bootstrap fails if it is unset.

A successful password reset updates the stored password hash and invalidates existing sessions. Reset-token storage, expiry, and the forgot-password response are documented in [API](api.md#auth).

## CSRF and origin handling

State-changing requests (`POST`, `PUT`, `PATCH`, and `DELETE`) must send the session-bound token from `/api/v1/auth/csrf-token` in the `X-CSRF-Token` header. The backend also validates `Origin`, or `Referer` when `Origin` is absent, against `FRONTEND_URL`. The frontend may refresh and retry once only for a `403` response with `code: "CSRF_TOKEN_INVALID"`; it must not retry `CSRF_ORIGIN_INVALID` or authorization `403` responses.

## Authorization and ownership

Provider endpoints require an authenticated provider session and enforce listing ownership.

`PATCH /api/v1/provider/applications/:id/reject` and `PATCH /api/v1/provider/applications/:id/restore` require an authenticated provider session that owns the listing. Owning providers get `404` for foreign or missing applications. `WAITING` applications are not visible to the provider and return `404` on reject.

`DELETE /api/v1/applicant/applications/:id` can be used only by the owning applicant. Ownership is enforced before an `ACTIVE` slot is released.

Public listing discovery never exposes `providerId`, `showExactAddress`, Cloudinary `publicId`, applicant profile values, eligibility reasons or warnings. Saved-listing and report actions do not expose reporter identity.

## Personalized listing responses

Personalized listing responses use `Vary: Cookie` and `Cache-Control: private, no-store, must-revalidate` to prevent shared-cache leakage of applicant-specific data. See [API](api.md#public-listing-discovery).

## Rate limits

Configured and documented rate limits use in-memory storage per backend process unless a shared throttler storage is configured:

- AI extraction: in-memory counters keyed by authenticated Provider ID. Limits apply per process instance, not globally across multiple replicas. Use a shared throttler storage before relying on these limits in a multi-replica deployment.
- Application apply/withdraw: keyed by authenticated applicant and listing. Four actions per 60 seconds; the fifth returns `429` with `code: "APPLICATION_ACTION_RATE_LIMITED"`. See [Application lifecycle](application-lifecycle.md#application-action-rate-limit).
- Provider reject/restore cooldown: `429` with `code: "PROVIDER_CURATION_RATE_LIMITED"` when a provider curation event for the same application happened within the last 60 seconds.
- Listing reports: five reports per hour per authenticated applicant (`429`, `code: "LISTING_REPORT_RATE_LIMITED"`).

## Cloudinary and email credentials

Cloudinary credentials are required in production and for local listing image uploads. Development startup without credentials, and the `503` upload behavior, are documented in [API](api.md#listing-images).

Password recovery uses Amazon SES. Production deployments require Amazon SES configuration.

## Dependency audit

Production dependencies are audited on every CI run. Development-only vulnerabilities (from tooling such as Jest, ESLint, @nestjs/cli) do not expose the production application and are tracked separately.

```bash
npm run audit:prod
```

This script checks production dependencies only and exits with a non-zero code if any high or critical vulnerability is found.

Development-only advisories confined to tooling such as `jest` and `eslint` are tracked separately from production. Those tools process source code, not untrusted user input.

## Main branch protection

All changes to `main` must be merged through a pull request. The branch must be up to date before merging, all review conversations must be resolved, and force pushes and branch deletion are blocked. Repository administrators do not bypass these protections.

The following GitHub Actions checks are required:

- Quality: `quality-format`, `quality-lint`, `quality-typecheck`, `test-unit`, `build-backend`
- Security: `npm-audit`, `codeql`, `dependency-review`
- Container: `docker-build`
- Database: `prisma-validate`, `prisma-generate`, `migration-check`
- End-to-end: `e2e-tests`

The ruleset also requires CodeQL results and blocks security alerts rated high or critical, along with code-scanning alerts rated as errors. Lower-severity findings remain visible for separate triage and remediation.

The repository currently has one authorized maintainer, so pull requests require zero approving reviews to avoid making merges impossible. Increase this requirement to at least one approval when a second trusted reviewer with write access is available.

## Docker CI

The GitHub Actions `docker-build` check runs for pull requests targeting `main` and pushes to `main`. It uses Docker Buildx with GitHub Actions cache, builds the image without registry authentication or image push, and starts the container against a temporary PostgreSQL service with `NODE_ENV=test` before calling `/api/v1/health`. It does not deploy and does not use AWS secrets.

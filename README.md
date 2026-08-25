# Renyqo Backend

Backend API for Renyqo, a smart rental platform for the German rental market.

## Stack

- NestJS
- TypeScript strict mode
- REST API first
- PostgreSQL 16
- Prisma ORM v7 with `@prisma/adapter-pg`
- Session authentication with `express-session`, `connect-pg-simple`, `passport`, and `passport-local`
- Password hashing with `bcrypt`
- Environment and DTO validation with `@nestjs/config`, `class-validator`, and `class-transformer`
- Listing image uploads with Cloudinary

## Requirements

- Node.js 22+
- npm 10+
- Docker and Docker Compose

## Setup

```bash
git clone https://github.com/Ramon-Saavedra/renyqo-app.git
cd renyqo-app
npm install
cp .env.example .env
```

Fill the required values in `.env`, especially `SESSION_SECRET`. Cloudinary credentials are required in production and for local listing image uploads.

Start PostgreSQL:

```bash
docker compose up -d
```

Run database migrations:

```bash
npx prisma migrate dev
```

The application queue migrations add and backfill a global FIFO sequence and build queue indexes. Run them during a deployment maintenance window with application writes stopped; the backfill and index creation are intentionally not online operations.

Generate the Prisma client:

```bash
npx prisma generate
```

Start the API:

```bash
npm run start:dev
```

## Environment Variables

| Variable                     | Required           | Description                                      |
| ---------------------------- | ------------------ | ------------------------------------------------ |
| `NODE_ENV`                   | yes                | `development`, `production`, or `test`           |
| `PORT`                       | yes                | HTTP port from `1` to `65535`                    |
| `DATABASE_URL`               | yes                | PostgreSQL connection string                     |
| `SESSION_SECRET`             | yes                | Session signing secret, minimum 32 characters    |
| `FRONTEND_URL`               | no                 | Allowed frontend origin for CORS                 |
| `AWS_REGION`                 | production/email   | AWS region used by Amazon SES                    |
| `SES_FROM_EMAIL`             | production/email   | Verified SES sender email address                |
| `CLOUDINARY_CLOUD_NAME`      | production/uploads | Cloudinary cloud name                            |
| `CLOUDINARY_API_KEY`         | production/uploads | Cloudinary API key                               |
| `CLOUDINARY_API_SECRET`      | production/uploads | Cloudinary API secret                            |
| `CLOUDINARY_FOLDER`          | no                 | Root Cloudinary folder, defaults to `renyqo`     |
| `OPENAI_API_KEY`             | yes                | OpenAI API key for listing assistance            |
| `OPENAI_LISTING_MODEL`       | yes                | OpenAI model used for structured extraction      |
| `OPENAI_TRANSCRIPTION_MODEL` | yes                | OpenAI model used for audio transcription        |
| `AI_RATE_LIMIT_WINDOW_MS`    | yes                | Per-process AI rate-limit window in milliseconds |
| `AI_TEXT_RATE_LIMIT`         | yes                | Provider text extractions allowed per window     |
| `AI_PDF_RATE_LIMIT`          | yes                | Provider PDF extractions allowed per window      |
| `AI_AUDIO_RATE_LIMIT`        | yes                | Provider audio extractions allowed per window    |

Production deployments should configure an approved, dated OpenAI model snapshot for `OPENAI_LISTING_MODEL` when the selected model family offers snapshots. Model changes require the same eval and review process as code changes.

## API

Global prefix: `/api/v1`

### Health

| Method | Path             | Auth | Description    |
| ------ | ---------------- | ---- | -------------- |
| `GET`  | `/api/v1/health` | No   | Liveness probe |

### Auth

| Method | Path                           | Auth    | Description                                      |
| ------ | ------------------------------ | ------- | ------------------------------------------------ |
| `POST` | `/api/v1/auth/register`        | No      | Register as applicant or provider and set cookie |
| `POST` | `/api/v1/auth/login`           | No      | Login and set cookie                             |
| `POST` | `/api/v1/auth/forgot-password` | No      | Request password reset instructions              |
| `POST` | `/api/v1/auth/reset-password`  | No      | Reset password with a valid reset token          |
| `POST` | `/api/v1/auth/logout`          | Session | Logout and clear cookie                          |
| `GET`  | `/api/v1/auth/me`              | Session | Return current user without password hash        |
| `GET`  | `/api/v1/auth/csrf-token`      | No      | Return the session-bound CSRF token              |

Public registration only accepts `applicant` and `provider`.

State-changing requests (`POST`, `PUT`, `PATCH`, and `DELETE`) must send the
session-bound token from `/api/v1/auth/csrf-token` in the `X-CSRF-Token` header.
The backend also validates `Origin`, or `Referer` when `Origin` is absent,
against `FRONTEND_URL`. The frontend may refresh and retry once only for a
`403` response with `code: "CSRF_TOKEN_INVALID"`; it must not retry
`CSRF_ORIGIN_INVALID` or authorization `403` responses.

Provider registration may also include optional identity fields:

- `providerType`: `private` or `company`
- `companyName`: required when `providerType` is `company`

If `providerType` is omitted, both `providerType` and `companyName` remain `null` for backwards compatibility. If `providerType` is `private`, `companyName` is stored as `null`.

Safe user responses from `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, and `GET /api/v1/auth/me` include `name`, `email`, `providerType`, and `companyName`, but never `passwordHash`.

Password recovery uses Amazon SES. `POST /api/v1/auth/forgot-password` always returns a neutral response whether the email exists or not. Reset tokens are generated securely, stored only as hashes, expire after 60 minutes, and are single-use. A successful reset updates the stored password hash and invalidates existing sessions.

### Me

| Method | Path                          | Auth    | Description                        |
| ------ | ----------------------------- | ------- | ---------------------------------- |
| `GET`  | `/api/v1/me/onboarding-state` | Session | Return role-based onboarding state |

### Public Listing Discovery

These public endpoints return only PUBLISHED listings with a publication date. Registration is not required.

| Method | Path                   | Auth          | Description                                                           |
| ------ | ---------------------- | ------------- | --------------------------------------------------------------------- |
| `GET`  | `/api/v1/listings`     | Public (opt.) | Browse published listings with filters, sorting and cursor pagination |
| `GET`  | `/api/v1/listings/:id` | Public (opt.) | Get public detail for a published listing                             |

Authentication is optional. When a valid applicant session is present, each listing includes a `profileMatch` value calculated from the applicant profile and listing requirements. Anonymous requests and providers receive `profileMatch: "UNKNOWN"`.

Supported query parameters for `GET /api/v1/listings`:

| Parameter       | Type    | Description                                                                                                                                       |
| --------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query`         | string  | Free-text search over title, city, ZIP and district (ILIKE)                                                                                       |
| `city`          | string  | Filter by city (case-insensitive)                                                                                                                 |
| `minRent`       | number  | Minimum cold rent                                                                                                                                 |
| `maxRent`       | number  | Maximum cold rent                                                                                                                                 |
| `minRooms`      | number  | Minimum rooms                                                                                                                                     |
| `maxRooms`      | number  | Maximum rooms                                                                                                                                     |
| `minLivingArea` | number  | Minimum living area                                                                                                                               |
| `maxLivingArea` | number  | Maximum living area                                                                                                                               |
| `availableBy`   | string  | Filter to listings available on or before a date (YYYY-MM-DD). Interpreted in `Europe/Berlin`. Listings with `availableFrom = null` are excluded. |
| `sort`          | string  | Sort order: `newest` (default), `price-asc`, `price-desc`, `area-desc`                                                                            |
| `onlyMatching`  | boolean | Requires a complete applicant profile. Returns `400` for anonymous/incomplete profiles, `403` for non-applicant sessions. Filters in PostgreSQL.  |
| `petsPolicy`    | string  | Filter by pets policy: `ALLOWED`, `BY_ARRANGEMENT`, `NOT_ALLOWED`                                                                                 |
| `limit`         | number  | Page size (default 20, max 50)                                                                                                                    |
| `cursor`        | string  | Opaque cursor for next page                                                                                                                       |

The response includes `total`, the exact count of filtered results before pagination. Total and page are calculated in a consistent Repeatable Read transaction.

Cursors are sort-specific: a cursor generated for one sort returns `400` when used with a different sort. Each cursor contains the active sort value plus `id` as a deterministic tie-breaker.

Three new indexes support the additional sort modes:
`(status, coldRent, id)`, `(status, livingArea, id)` and `(status, availableFrom)`.

Collection response items include:

- `district`, `publishedAt`, `isNew` (true within the first 7 days after `publishedAt`, computed server-side per-request)
- `petsPolicy` at the item level
- `profileMatch`: `MATCH`, `NO_MATCH`, `PROFILE_INCOMPLETE` or `UNKNOWN`
- narrow public summary with `coverImage` containing only `secureUrl`
- never exposes `providerId`, `showExactAddress`, Cloudinary `publicId`, applicant profile values, eligibility reasons or warnings

Detail response includes `district`, `isNew` and `profileMatch` at the top level. `requirements.petsPolicy` is preserved in the nested requirements object and is not duplicated at the top level.

Personalized responses (any request carrying a valid applicant session) use `Vary: Cookie` and `Cache-Control: private, no-store, must-revalidate` to prevent shared-cache leakage of applicant-specific data.

DRAFT, PAUSED, ARCHIVED and RENTED listings are not accessible through these endpoints.

### Provider Listings

Provider endpoints require an authenticated provider session and enforce listing ownership.

| Method  | Path                                                | Auth     | Description                                             |
| ------- | --------------------------------------------------- | -------- | ------------------------------------------------------- |
| `POST`  | `/api/v1/provider/listings`                         | Provider | Create a draft listing, optionally with its first image |
| `GET`   | `/api/v1/provider/listings`                         | Provider | Get all listings owned by the provider                  |
| `GET`   | `/api/v1/provider/listings/:id`                     | Provider | Get one owned listing                                   |
| `PATCH` | `/api/v1/provider/listings/:id`                     | Provider | Update an owned listing                                 |
| `PATCH` | `/api/v1/provider/listings/:id/publish`             | Provider | Publish an owned listing                                |
| `PATCH` | `/api/v1/provider/listings/:id/draft`               | Provider | Move a listing back to draft                            |
| `PATCH` | `/api/v1/provider/listings/:id/archive`             | Provider | Archive an owned listing                                |
| `PATCH` | `/api/v1/provider/listings/:id/rent`                | Provider | Mark a listing as rented and finalize applications      |
| `GET`   | `/api/v1/provider/listings/:id/active-applications` | Provider | Get ACTIVE applications with provider-safe applicant summaries |

Required property fields to publish: `street`, `zip`, `city`, `livingArea`, `rooms`, `bedrooms`, `coldRent`, `availableFrom`. A final `title` is also required; the frontend sends either its Provider override or its deterministic auto-title.

### AI-Assisted Listing Extraction

Authenticated Providers can request suggestions from free text, a PDF/Exposé, or an audio recording. These endpoints only return a partial, backend-validated prefill; they never create, update, or publish a listing.

| Method | Path                                             | Auth     | Description                                      |
| ------ | ------------------------------------------------ | -------- | ------------------------------------------------ |
| `POST` | `/api/v1/provider/listings/ai-extractions/text`  | Provider | Extract listing fields from JSON text            |
| `POST` | `/api/v1/provider/listings/ai-extractions/pdf`   | Provider | Extract listing fields from a PDF upload         |
| `POST` | `/api/v1/provider/listings/ai-extractions/audio` | Provider | Transcribe and extract listing fields from audio |

`text` accepts `{ "text": "..." }` with a maximum length of 20,000 characters. PDF and audio use `multipart/form-data` with the `file` field. PDF is limited to 10 MB; audio is limited to 25 MB and accepts `audio/mpeg`, `audio/mp4`, `audio/x-m4a`, `audio/wav`, and `audio/webm`.

All responses use this shape:

```json
{
  "values": { "city": "Berlin", "coldRent": 1200 },
  "requiredMissingFields": ["street", "zip", "city"],
  "recommendedMissingFields": ["petsPolicy"],
  "inconsistencies": [],
  "warnings": []
}
```

Only present extracted values are validated. Invalid extracted values are omitted from `values` and reported in `inconsistencies`; required and recommended missing fields are calculated deterministically by the backend. Titles are extracted only when explicitly present and are never generated by OpenAI. The normal Provider-controlled save and publish flow remains authoritative.

The field-level semantic specification is sent to OpenAI for text, PDF, and transcribed audio. Text and audio transcripts additionally use a narrow deterministic backend normalizer for unambiguous German living-area units and availability dates. A disagreement between deterministic evidence and an AI value is returned as an inconsistency; ambiguous dates are omitted and returned as warnings. Immediate availability uses the current `Europe/Berlin` date supplied by the backend.

Files are processed in memory only. They are not stored on disk, in PostgreSQL, or in Cloudinary. The OpenAI Responses calls explicitly use `store: false`; PDF files are sent directly as request input and do not use the OpenAI Files API. OpenAI still processes submitted text, PDF, audio, and property data as a third party. Its default abuse-monitoring logs may retain customer content for up to 30 days, subject to OpenAI account data controls and exceptional safety review of flagged file inputs.

Upload validation checks the declared MIME type, configured size limit, and expected container structure before content is sent to OpenAI. This is a defensive format check, not malware scanning.

AI extraction uses in-memory rate-limit counters keyed by the authenticated Provider ID. The configured limits apply per process instance, not globally across multiple replicas. Use a shared throttler storage before relying on these limits in a multi-replica deployment.

Run live Listing AI evals explicitly with `npm run eval:listing-assistance`. This command uses the configured OpenAI API and may incur cost. The eval corpus covers text and post-transcription inputs; standard CI tests use typed stubs and do not call OpenAI.

`POST /api/v1/provider/listings` accepts either `application/json` for listing data only, or `multipart/form-data` with the same listing fields and an optional `file` field. When `file` is provided, the API uploads the image to Cloudinary, creates the listing, stores image metadata in `listing_images`, and keeps the listing `photos` array in sync for existing consumers.

Example with first image:

```bash
curl -X POST http://localhost:3000/api/v1/provider/listings \
  -H "Cookie: sid=<session-cookie>" \
  -F "objectType=apartment" \
  -F "city=Berlin" \
  -F "zip=10115" \
  -F "file=@/path/to/photo.jpg"
```

### Listing Images

Listing image uploads are stored in Cloudinary and persisted as listing image metadata in PostgreSQL.
In development, the API can start without Cloudinary credentials. Uploading images still requires the three Cloudinary credential variables; otherwise the upload endpoint returns `503`.

| Method   | Path                                                   | Auth     | Description                                     |
| -------- | ------------------------------------------------------ | -------- | ----------------------------------------------- |
| `POST`   | `/api/v1/provider/listings/:listingId/images`          | Provider | Upload an additional image for an owned listing |
| `GET`    | `/api/v1/provider/listings/:listingId/images`          | Provider | Get the images of an owned listing              |
| `PATCH`  | `/api/v1/provider/listings/:listingId/images/order`    | Provider | Reorder the images of an owned listing          |
| `DELETE` | `/api/v1/provider/listings/:listingId/images/:imageId` | Provider | Delete one image of an owned listing            |

Request format:

- `Content-Type`: `multipart/form-data`
- File field: `file`
- Allowed MIME types: `image/jpeg`, `image/png`, `image/webp`
- Maximum file size: `10 MB`

Example:

```bash
curl -X POST http://localhost:3000/api/v1/provider/listings/<listing-id>/images \
  -H "Cookie: sid=<session-cookie>" \
  -F "file=@/path/to/photo.jpg"
```

Response:

```json
{
  "id": "00000000-0000-4000-8000-000000000003",
  "listingId": "00000000-0000-4000-8000-000000000002",
  "secureUrl": "https://res.cloudinary.com/example/image/upload/abc.jpg",
  "position": 0,
  "isCover": true,
  "createdAt": "2026-07-06T10:00:00.000Z"
}
```

`GET /api/v1/provider/listings/:listingId/images` returns the images ordered by `position`:

```json
[
  {
    "id": "00000000-0000-4000-8000-000000000003",
    "secureUrl": "https://res.cloudinary.com/example/image/upload/abc.jpg",
    "position": 0,
    "isCover": true
  }
]
```

`GET /api/v1/provider/listings/:id` includes the same `images` array in the listing detail response.

`PATCH /api/v1/provider/listings/:listingId/images/order` accepts `{ "imageIds": ["..."] }` and requires the complete current image set: duplicated, missing or foreign image IDs are rejected with `400`. It returns the reordered images.

`DELETE /api/v1/provider/listings/:listingId/images/:imageId` removes the image record and compacts the remaining positions in one transaction, then deletes the Cloudinary asset, and returns `204`. If the database transaction fails, the Cloudinary asset is kept untouched; if the Cloudinary deletion fails afterwards, the failure is logged and the image stays removed.

After every delete or reorder, the image at `position` `0` becomes the only cover and the listing `photos` array is kept in sync for existing consumers. `ListingImage` records are the authoritative source for listing images.

### Applications

| Method   | Path                                          | Auth      | Description                                            |
| -------- | --------------------------------------------- | --------- | ------------------------------------------------------ |
| `GET`    | `/api/v1/listings/:id/eligibility`            | Applicant | Read explainable eligibility for the current applicant |
| `POST`   | `/api/v1/listings/:id/apply`                  | Applicant | Apply to a published listing                           |
| `GET`    | `/api/v1/applicant/applications`              | Applicant | Get applications submitted by the current applicant    |
| `DELETE` | `/api/v1/applicant/applications/:id`          | Applicant | Withdraw one owned application                         |
| `GET`    | `/api/v1/provider/applications`               | Provider  | Get applications across provider listings              |
| `GET`    | `/api/v1/provider/listings/:id/applications`  | Provider  | Get applications for an owned listing                  |
| `GET`    | `/api/v1/provider/listings/:id/active-applications` | Provider | Get ACTIVE applications with provider-safe applicant summaries |
| `GET`    | `/api/v1/provider/listings/:id/waiting-count` | Provider  | Get the waiting application count for an owned listing |
| `PATCH`  | `/api/v1/provider/applications/:id/reject`    | Provider  | Reject one owned ACTIVE application                    |

Only published listings accept applications. RENTED listings do not accept applications and are excluded from applicant discovery.

`GET /api/v1/provider/listings/:id/active-applications` returns at most five `ACTIVE` applications for an owned listing, ordered by `createdAt` ascending. Each item includes the application fields plus a nested `applicant` summary with Provider-safe identity and profile fields (`name`, `email`, household counts, income proof flags, pets and smoking). It never includes `WAITING` applications, `queueOrder`, password hashes or unrelated user fields.

`GET /api/v1/listings/:id/eligibility` is read-only. It performs no database mutation, loads the applicant profile of the authenticated session from the database, evaluates the current listing requirements and returns `canApply`, `reasons`, `warnings` and `evaluatedAt`. Eligibility data supplied by a client is never accepted as authoritative; the endpoint takes no request body.

`POST /api/v1/listings/:id/apply` always recalculates eligibility from current database data inside the same transaction that creates the application. A previous frontend eligibility result is never trusted. A rejected application returns `422` with the same explainable payload, where `evaluatedAt` is the timestamp of the evaluation that caused the rejection.

The first five eligible applications are `ACTIVE`; later eligible applications are `WAITING`. Provider application lists never include `WAITING` applications, and the waiting-count endpoint returns only the count, never applicant identities, profiles, income or eligibility details. A duplicate live (`ACTIVE` or `WAITING`) application for the same listing returns `409`. Only a previous `WITHDRAWN` application allows re-applying; `REJECTED` and `ACCEPTED` applications remain terminal and also return `409` on a new application.

`DELETE /api/v1/applicant/applications/:id` can be used only by the owning applicant. It accepts `ACTIVE` and `WAITING` applications, changes the status to `WITHDRAWN`, and returns the application status and dates without exposing applicant or provider internals. Repeating the request for an already withdrawn application is idempotent. Withdrawing an `ACTIVE` application releases one slot and promotes the oldest still-eligible `WAITING` application in the same Serializable transaction.

Withdrawing no longer permanently blocks re-applying. `POST /api/v1/listings/:id/apply` creates a new application row with a new `id` and a new `queueOrder` when the applicant's most recent application for that listing is `WITHDRAWN`. The previous `WITHDRAWN` row is kept unchanged as history. The new status is recalculated from the current listing state, so a re-application may be `ACTIVE` (if a slot is free) or `WAITING` (if the active limit is full). Re-applications are subject to the same `PUBLISHED` listing and eligibility checks as first-time applications. `REJECTED` and `ACCEPTED` applications remain terminal and block new applications.

`POST /api/v1/listings/:id/apply` and `DELETE /api/v1/applicant/applications/:id` share a backend rate-limit bucket keyed by the authenticated applicant and listing. Four application actions are allowed per 60 seconds; the fifth rapid action returns `429` with `code: "APPLICATION_ACTION_RATE_LIMITED"`. This permits two complete apply/withdraw cycles in a short window while limiting automated history-row abuse. The application-scoped in-memory storage implements the NestJS throttler contract and applies per backend process; configure shared throttler storage before running multiple replicas.

### Waiting queue promotion

Promotion is an internal backend operation with no HTTP endpoint. Providers cannot promote a waiting applicant manually, and the queue is never reordered by income, assets, SCHUFA or provider preference.

`ApplicationsService.promoteWaitingApplications(listingId)` promotes the oldest eligible `WAITING` applications by `queueOrder`, rechecks eligibility immediately before each promotion and stops at the five-active limit. It runs in a Serializable transaction with row locks and serialization-conflict retries, so concurrent promotions can never exceed five `ACTIVE` applications.

Withdrawing an `ACTIVE` application calls the private `promoteWithinTransaction(tx, listing)` inside the same Serializable transaction that writes the `WITHDRAWN` status, immediately after that update. That keeps slot release and FIFO promotion atomic. Ownership is enforced before the slot is released.

### Application lifecycle: reject, rent and terminal states

`PATCH /api/v1/provider/applications/:id/reject` requires an authenticated provider session that owns the listing. Only `ACTIVE` applications may be rejected; `WAITING` applications are not visible to the provider and return `404`. The rejection reason is always `NOT_SELECTED` and is stored in `publicReason` alongside `rejectedAt`. Invalid state transitions return `409`. Rejecting an `ACTIVE` application promotes the oldest still-eligible `WAITING` application in the same Serializable transaction.

`PATCH /api/v1/provider/listings/:id/rent` requires `{ "selectedApplicationId": "uuid" }`. The listing must be `PUBLISHED` or `PAUSED`, and the selected application must be `ACTIVE` and belong to the listing. In one atomic Serializable transaction:

- Listing changes to `RENTED` with `rentedAt` set.
- The selected application changes to `ACCEPTED`.
- Every other `ACTIVE` and `WAITING` application changes to `REJECTED` with `publicReason` set to `LISTING_RENTED` and `rejectedAt` set.
- No waiting application is promoted.

RENTED listings disappear from applicant discovery and do not accept new applications.

Application terminal states are `REJECTED`, `WITHDRAWN`, `ACCEPTED` and listing `RENTED`. These states serve as the authoritative source for downstream features such as view restrictions and chat availability. `WITHDRAWN` is terminal for the row it marks, but it is the only terminal state that allows a new application row to be created afterwards; `REJECTED` and `ACCEPTED` block re-applying.

`GET /api/v1/applicant/applications` returns every application row submitted by the current applicant, ordered by `createdAt` descending (newest first). Because re-applying after withdrawal creates a new row, the response may legitimately contain multiple rows with the same `listingId`. The frontend should treat the most recent row for a given listing as the current application state; if that row is `ACTIVE` or `WAITING` it is the live application, otherwise the listing has no live application. The response never exposes queue position, provider identity, private address, internal eligibility data or provider comments.

### Applicant Profile

| Method  | Path                        | Auth      | Description                                    |
| ------- | --------------------------- | --------- | ---------------------------------------------- |
| `GET`   | `/api/v1/applicant/profile` | Applicant | Get the applicant profile, or `404` if missing |
| `PATCH` | `/api/v1/applicant/profile` | Applicant | Create or update the applicant profile         |

**PATCH contract:**

- Omitted fields retain their existing value.
- `null` explicitly clears a field.
- Empty or whitespace-only strings normalize to `null`.
- An empty body returns `400`.
- `peopleCount` is read-only and derived by the backend; submitting it returns `400`.

**Household invariant:**

`adultsCount` and `childrenCount` must be provided together or neither. When both are present, `peopleCount` is calculated as `adultsCount + childrenCount`. The database enforces this with a `CHECK` constraint, and the service validates merged state inside a Serializable transaction with retries.

**Response:**

Both `GET` and `PATCH` return only business fields:

```text
householdNetIncome, incomeProofAvailable, schufaAvailable,
peopleCount, adultsCount, childrenCount,
hasPets, petsNote, smokingStatus
```

Internal identifiers and timestamps are not exposed.

**Migration:**

Existing profiles with incomplete household counts are cleaned up: rows with both `adultsCount` and `childrenCount` get `peopleCount` recalculated; ambiguous rows are cleared. A database constraint prevents future invalid states.

### Dashboard

| Method | Path                                 | Auth     | Description                      |
| ------ | ------------------------------------ | -------- | -------------------------------- |
| `GET`  | `/api/v1/provider/dashboard/summary` | Provider | Summary of the provider listings |

## Scripts

| Script                                | Purpose                       |
| ------------------------------------- | ----------------------------- |
| `npm run start:dev`                   | Start in watch mode           |
| `npm run build`                       | Compile to `dist/`            |
| `npm run lint`                        | Run ESLint                    |
| `npm run format`                      | Format source files           |
| `npm run typecheck`                   | TypeScript check without emit |
| `npm run test`                        | Run unit tests                |
| `npm run test:e2e`                    | Run end-to-end tests          |
| `npm run test:e2e:listing-assistance` | Run Listing AI HTTP tests     |
| `npm run test:cov`                    | Run tests with coverage       |
| `npm run eval:listing-assistance`     | Run live Listing AI evals     |

## E2E Testing

End-to-end tests require a dedicated temporary PostgreSQL database and fail closed unless both variables are set:

```bash
E2E_DATABASE_URL=postgresql://<test-user>:<test-password>@localhost:<port>/<project>_e2e
E2E_DATABASE_ALLOW_RESET=true
```

The suite clears this dedicated database between tests. The database name must end with `_e2e`; the suite rejects `renyqo_dev`, staging and production database names before connecting or cleaning. Never point these variables at a development or production database.

For local Docker E2E runs, start the isolated database and apply migrations to it:

```bash
docker compose -f docker-compose.e2e.yml up -d
DATABASE_URL=postgresql://renyqo:renyqo_dev@localhost:5434/renyqo_e2e?schema=public npx prisma migrate deploy
```

## Quality Gate

Before shipping backend changes:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Main Branch Protection

All changes to `main` must be merged through a pull request. The branch must be up to date before merging, all review conversations must be resolved, and force pushes and branch deletion are blocked. Repository administrators do not bypass these protections.

The following GitHub Actions checks are required:

- Quality: `quality-format`, `quality-lint`, `quality-typecheck`, `test-unit`, `build-backend`
- Security: `npm-audit`, `codeql`, `dependency-review`
- Container: `docker-build`
- Database: `prisma-validate`, `prisma-generate`, `migration-check`
- End-to-end: `e2e-tests`

The ruleset also requires CodeQL results and blocks security alerts rated high or critical, along with code-scanning alerts rated as errors. Lower-severity findings remain visible for separate triage and remediation.

The repository currently has one authorized maintainer, so pull requests require zero approving reviews to avoid making merges impossible. Increase this requirement to at least one approval when a second trusted reviewer with write access is available.

## Docker

```bash
docker build -t renyqo-backend .
docker run --env-file .env -p 3000:3000 renyqo-backend
```

The production container runs `node dist/main` with production dependencies only. It requires the same environment variables documented above.

The GitHub Actions `docker-build` check runs for pull requests targeting `main` and pushes to `main`. It uses Docker Buildx with GitHub Actions cache, builds the image without registry authentication or image push, and starts the container against a temporary PostgreSQL service with `NODE_ENV=test` before calling `/api/v1/health`. It does not deploy and does not use AWS secrets.

## Project Structure

```txt
src/
  applicant-profile/    Applicant profile used for eligibility
  applications/         Listing applications
  auth/                 Session-based auth
  common/               Shared guards and types
  config/               Environment validation
  dashboard/            Provider dashboard summary
  email/                Amazon SES email delivery
  health/               Liveness endpoint
  listing-images/       Cloudinary-backed listing images
  listing-assistance/   Provider-only AI listing extraction
  listings/             Provider listing management
  me/                   Current-user onboarding state
  prisma/               Prisma service
  users/                User service and safe user mapping
prisma/
  migrations/
  schema.prisma
docker-compose.yml
```

## Security

Security is a priority. We follow secure backend practices, validate all inputs, hash passwords, and never store or expose secrets.

### Dependency audit

Production dependencies are audited on every CI run. Development-only vulnerabilities (from tooling such as Jest, ESLint, @nestjs/cli) do not expose the production application and are tracked separately.

```bash
npm run audit:prod
```

This script checks production dependencies only and exits with a non-zero code if any high or critical vulnerability is found.

The 25 `brace-expansion` advisories reported by `npm audit` at the time of writing are confined to `jest` and `eslint` development tooling. These tools process source code, not untrusted user input, and the affected transitive lines (`brace-expansion@1.x` and `brace-expansion@2.x`) have no compatible patched release. They are resolved by following the upstream package updates.

## License

See [LICENSE](./LICENSE).

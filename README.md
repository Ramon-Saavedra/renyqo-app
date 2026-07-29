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

- Node.js 20+
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

| Variable                | Required           | Description                                   |
| ----------------------- | ------------------ | --------------------------------------------- |
| `NODE_ENV`              | yes                | `development`, `production`, or `test`        |
| `PORT`                  | yes                | HTTP port from `1` to `65535`                 |
| `DATABASE_URL`          | yes                | PostgreSQL connection string                  |
| `SESSION_SECRET`        | yes                | Session signing secret, minimum 32 characters |
| `FRONTEND_URL`          | no                 | Allowed frontend origin for CORS              |
| `AWS_REGION`            | production/email   | AWS region used by Amazon SES                 |
| `SES_FROM_EMAIL`        | production/email   | Verified SES sender email address             |
| `CLOUDINARY_CLOUD_NAME` | production/uploads | Cloudinary cloud name                         |
| `CLOUDINARY_API_KEY`    | production/uploads | Cloudinary API key                            |
| `CLOUDINARY_API_SECRET` | production/uploads | Cloudinary API secret                         |
| `CLOUDINARY_FOLDER`     | no                 | Root Cloudinary folder, defaults to `renyqo`  |

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

Public registration only accepts `applicant` and `provider`.

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

### Listings

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
| `GET`   | `/api/v1/provider/listings/:id/active-applications` | Provider | Get active applications for one listing                 |

Required fields to publish: `title`, `street`, `livingArea`, `rooms`, `bedrooms`, `coldRent`, `availableFrom`.

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

| Method | Path                                          | Auth      | Description                                            |
| ------ | --------------------------------------------- | --------- | ------------------------------------------------------ |
| `GET`  | `/api/v1/listings/:id/eligibility`            | Applicant | Read explainable eligibility for the current applicant |
| `POST` | `/api/v1/listings/:id/apply`                  | Applicant | Apply to a published listing                           |
| `GET`  | `/api/v1/applicant/applications`              | Applicant | Get applications submitted by the current applicant    |
| `GET`  | `/api/v1/provider/applications`               | Provider  | Get applications across provider listings              |
| `GET`  | `/api/v1/provider/listings/:id/applications`  | Provider  | Get applications for an owned listing                  |
| `GET`  | `/api/v1/provider/listings/:id/waiting-count` | Provider  | Get the waiting application count for an owned listing |

Only published listings accept applications.

`GET /api/v1/listings/:id/eligibility` is read-only. It performs no database mutation, loads the applicant profile of the authenticated session from the database, evaluates the current listing requirements and returns `canApply`, `reasons`, `warnings` and `evaluatedAt`. Eligibility data supplied by a client is never accepted as authoritative; the endpoint takes no request body.

`POST /api/v1/listings/:id/apply` always recalculates eligibility from current database data inside the same transaction that creates the application. A previous frontend eligibility result is never trusted. A rejected application returns `422` with the same explainable payload, where `evaluatedAt` is the timestamp of the evaluation that caused the rejection.

The first five eligible applications are `ACTIVE`; later eligible applications are `WAITING`. Provider application lists never include `WAITING` applications, and the waiting-count endpoint returns only the count, never applicant identities, profiles, income or eligibility details. Duplicate applications return `409`.

### Waiting queue promotion

Promotion is an internal backend operation with no HTTP endpoint. Providers cannot promote a waiting applicant manually, and the queue is never reordered by income, assets, SCHUFA or provider preference.

`ApplicationsService.promoteWaitingApplications(listingId)` promotes the oldest eligible `WAITING` applications by `queueOrder`, rechecks eligibility immediately before each promotion and stops at the five-active limit. It runs in a Serializable transaction with row locks and serialization-conflict retries, so concurrent promotions can never exceed five `ACTIVE` applications.

No application status transition releases an `ACTIVE` slot yet, because reject and withdraw are not part of this phase. When that transition is implemented, it must call the private `promoteWithinTransaction(tx, listing)` inside the same Serializable transaction that writes the `REJECTED` or `WITHDRAWN` status, immediately after that update. That keeps slot release and FIFO promotion atomic. Ownership must be enforced by that transition before the slot is released.

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

| Script              | Purpose                       |
| ------------------- | ----------------------------- |
| `npm run start:dev` | Start in watch mode           |
| `npm run build`     | Compile to `dist/`            |
| `npm run lint`      | Run ESLint                    |
| `npm run format`    | Format source files           |
| `npm run typecheck` | TypeScript check without emit |
| `npm run test`      | Run unit tests                |
| `npm run test:e2e`  | Run end-to-end tests          |
| `npm run test:cov`  | Run tests with coverage       |

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

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

| Method | Path                    | Auth    | Description                                      |
| ------ | ----------------------- | ------- | ------------------------------------------------ |
| `POST` | `/api/v1/auth/register` | No      | Register as applicant or provider and set cookie |
| `POST` | `/api/v1/auth/login`    | No      | Login and set cookie                             |
| `POST` | `/api/v1/auth/logout`   | Session | Logout and clear cookie                          |
| `GET`  | `/api/v1/auth/me`       | Session | Return current user without password hash        |

Public registration only accepts `applicant` and `provider`.

Provider registration may also include optional identity fields:

- `providerType`: `private` or `company`
- `companyName`: required when `providerType` is `company`

If `providerType` is omitted, both `providerType` and `companyName` remain `null` for backwards compatibility. If `providerType` is `private`, `companyName` is stored as `null`.

Safe user responses from `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, and `GET /api/v1/auth/me` include `name`, `email`, `providerType`, and `companyName`, but never `passwordHash`.

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

| Method | Path                                          | Auth     | Description                                     |
| ------ | --------------------------------------------- | -------- | ----------------------------------------------- |
| `POST` | `/api/v1/provider/listings/:listingId/images` | Provider | Upload an additional image for an owned listing |

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

### Applications

| Method | Path                                         | Auth      | Description                                         |
| ------ | -------------------------------------------- | --------- | --------------------------------------------------- |
| `POST` | `/api/v1/listings/:id/apply`                 | Applicant | Apply to a published listing                        |
| `GET`  | `/api/v1/applicant/applications`             | Applicant | Get applications submitted by the current applicant |
| `GET`  | `/api/v1/provider/applications`              | Provider  | Get applications across provider listings           |
| `GET`  | `/api/v1/provider/listings/:id/applications` | Provider  | Get applications for an owned listing               |

Only published listings accept applications. Duplicate applications return `409`.

### Applicant Profile

| Method  | Path                        | Auth      | Description                                    |
| ------- | --------------------------- | --------- | ---------------------------------------------- |
| `GET`   | `/api/v1/applicant/profile` | Applicant | Get the applicant profile, or `404` if missing |
| `PATCH` | `/api/v1/applicant/profile` | Applicant | Create or update the applicant profile         |

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

## Project Structure

```txt
src/
  applicant-profile/    Applicant profile used for eligibility
  applications/         Listing applications
  auth/                 Session-based auth
  common/               Shared guards and types
  config/               Environment validation
  dashboard/            Provider dashboard summary
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

## License

See [LICENSE](./LICENSE).

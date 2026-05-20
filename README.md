# Renyqo Backend

Backend API for Renyqo, a smart rental platform for Germany.

## Stack

- [NestJS](https://nestjs.com/) (Node.js framework)
- TypeScript (strict mode)
- PostgreSQL 16 via Docker
- Prisma v7 with `@prisma/adapter-pg`
- `express-session` + `connect-pg-simple` â€” HTTP-only cookie sessions
- `passport` + `passport-local` â€” local auth strategy
- `bcrypt` â€” password hashing
- `@nestjs/config` + `class-validator` â€” env and DTO validation

## Requirements

- Node.js 20+
- npm 10+
- Docker + Docker Compose

## Setup

```bash
git clone https://github.com/Ramon-Saavedra/renyqo-app.git
cd renyqo-app
npm install
cp .env.example .env
# Fill in SESSION_SECRET (min 32 chars)
```

Start the database (PostgreSQL exposed on port **5433**):

```bash
docker compose up -d
```

Run migrations:

```bash
npx prisma migrate dev
```

Start the server:

```bash
npm run start:dev
```

## Environment variables

| Variable         | Required | Description                                    |
| ---------------- | -------- | ---------------------------------------------- |
| `NODE_ENV`       | yes      | `development`, `production` or `test`          |
| `PORT`           | yes      | HTTP port (1â€“65535)                            |
| `DATABASE_URL`   | yes      | PostgreSQL connection string                   |
| `SESSION_SECRET` | yes      | Session signing secret (min 32 characters)     |

## API

Global prefix: `/api/v1`

### Health

| Method | Path             | Auth | Description    |
| ------ | ---------------- | ---- | -------------- |
| `GET`  | `/api/v1/health` | â€”    | Liveness probe |

### Auth

| Method | Path                    | Auth        | Description                                            |
| ------ | ----------------------- | ----------- | ------------------------------------------------------ |
| `POST` | `/api/v1/auth/register` | â€”           | Register as applicant/provider â€” sets `sid` cookie automatically |
| `POST` | `/api/v1/auth/login`    | â€”           | Login, sets `sid` cookie                               |
| `POST` | `/api/v1/auth/logout`   | ðŸ”’ Session | Logout, clears `sid` cookie                            |
| `GET`  | `/api/v1/auth/me`       | ðŸ”’ Session | Returns current user (no password hash)                |

Public registration is limited to `applicant` and `provider` roles.

### Me

| Method | Path                          | Auth        | Description                         |
| ------ | ----------------------------- | ----------- | ----------------------------------- |
| `GET`  | `/api/v1/me/onboarding-state` | ðŸ”’ Session | Returns role-based onboarding state |

### Listings (Provider only)

| Method  | Path                                                   | Auth        | Description                                        |
| ------- | ------------------------------------------------------ | ----------- | -------------------------------------------------- |
| `POST`  | `/api/v1/provider/listings`                            | ðŸ”’ Provider | Create a listing (status: `DRAFT`)                 |
| `GET`   | `/api/v1/provider/listings`                            | ðŸ”’ Provider | Get all listings owned by the provider             |
| `GET`   | `/api/v1/provider/listings/:id`                        | ðŸ”’ Provider | Get a single listing (ownership enforced)          |
| `PATCH` | `/api/v1/provider/listings/:id`                        | ðŸ”’ Provider | Update a listing                                   |
| `PATCH` | `/api/v1/provider/listings/:id/publish`                | ðŸ”’ Provider | Publish a listing                                  |
| `PATCH` | `/api/v1/provider/listings/:id/draft`                  | ðŸ”’ Provider | Move a published listing back to `DRAFT`           |
| `PATCH` | `/api/v1/provider/listings/:id/archive`                | ðŸ”’ Provider | Archive a listing                                  |
| `GET`   | `/api/v1/provider/listings/:id/active-applications`    | ðŸ”’ Provider | Get `ACTIVE` applications for a listing            |

Required fields to publish: `title`, `street`, `livingArea`, `rooms`, `bedrooms`, `coldRent`, `availableFrom`.

### Dashboard (Provider only)

| Method | Path                                 | Auth        | Description                            |
| ------ | ------------------------------------ | ----------- | -------------------------------------- |
| `GET`  | `/api/v1/provider/dashboard/summary` | ðŸ”’ Provider | Summary of the provider's listings     |

### Applications

| Method | Path                                         | Auth        | Description                                                       |
| ------ | -------------------------------------------- | ----------- | ----------------------------------------------------------------- |
| `POST` | `/api/v1/listings/:id/apply`                 | ðŸ”’ Applicant | Apply to a listing                                               |
| `GET`  | `/api/v1/applicant/applications`             | ðŸ”’ Applicant | Get all applications submitted by the current applicant          |
| `GET`  | `/api/v1/provider/applications`              | ðŸ”’ Provider  | Get all applications across all provider listings                |
| `GET`  | `/api/v1/provider/listings/:id/applications` | ðŸ”’ Provider  | Get all applications for a specific listing (ownership enforced) |

Only `PUBLISHED` listings accept applications. Duplicate applications return `409`. If fewer than 5 `ACTIVE` applications exist the new one is `ACTIVE`, otherwise `PENDING_QUEUE`.

### Applicant Profile

| Method  | Path                        | Auth        | Description                                          |
| ------- | --------------------------- | ----------- | ---------------------------------------------------- |
| `GET`   | `/api/v1/applicant/profile` | ðŸ”’ Applicant | Get the applicant's profile (`404` if none yet)     |
| `PATCH` | `/api/v1/applicant/profile` | ðŸ”’ Applicant | Create or update the applicant's profile (upsert)   |

## CI

| Workflow       | Jobs                                                                     |
| -------------- | ------------------------------------------------------------------------ |
| `ci.yml`       | `quality-format`, `quality-lint`, `quality-typecheck`, `test-unit`, `build-backend` |
| `security.yml` | `dependency-review`, `npm-audit`, `codeql-analysis`                      |
| `docker.yml`   | `docker-build`                                                           |
| `database.yml` | `prisma-validate`, `prisma-generate`, `migration-check`                  |

## Docker

```bash
docker build -t renyqo-backend .
docker run --env-file .env -p 3000:3000 renyqo-backend
```

## Scripts

| Script              | Purpose                       |
| ------------------- | ----------------------------- |
| `npm run start:dev` | Start in watch mode           |
| `npm run build`     | Compile to `dist/`            |
| `npm run lint`      | Run ESLint                    |
| `npm run format`    | Format with Prettier          |
| `npm run typecheck` | TypeScript check without emit |
| `npm run test`      | Run unit tests                |
| `npm run test:e2e`  | Run end-to-end tests          |
| `npm run test:cov`  | Run tests with coverage       |

## Project structure

```
src/
  auth/                 Register, login, logout, me — session-based auth
  me/                   Onboarding state per role
  listings/             Provider listing management
  dashboard/            Provider dashboard summary
  applications/         Apply to listings, view applications
  applicant-profile/    Applicant profile (used for eligibility)
  users/                User service and SafeUser type
  common/               Guards (AuthenticatedGuard, ProviderOnlyGuard, ApplicantOnlyGuard)
  config/               Env validation
  prisma/               PrismaService (global)
  __mocks__/            Jest module mocks
  app.module.ts
  main.ts
prisma/
  schema.prisma
prisma.config.ts
docker-compose.yml
```

## License

See [LICENSE](./LICENSE).
```bash
docker build -t renyqo-backend .
docker run --env-file .env -p 3000:3000 renyqo-backend
```

## Scripts

| Script                 | Purpose                               |
| ---------------------- | ------------------------------------- |
| `npm run start:dev`    | Start in watch mode                   |
| `npm run build`        | Compile to `dist/`                    |
| `npm run lint`         | Run ESLint                            |
| `npm run format`       | Format with Prettier                  |
| `npm run typecheck`    | TypeScript check without emit         |
| `npm run test`         | Run unit tests                        |
| `npm run test:e2e`     | Run end-to-end tests                  |
| `npm run test:cov`     | Run tests with coverage               |

## Project structure

```
src/
  auth/                 Register, login, logout, me â€” session-based auth
  me/                   Onboarding state per role
  listings/             Provider listing management
  dashboard/            Provider dashboard summary
  applications/         Apply to listings, view applications
  applicant-profile/    Applicant profile (used for eligibility)
  users/                User service and SafeUser type
  common/               Guards (AuthenticatedGuard, ProviderOnlyGuard, ApplicantOnlyGuard)
  config/               Env validation
  prisma/               PrismaService (global)
  __mocks__/            Jest module mocks
  app.module.ts
  main.ts
prisma/
  schema.prisma
prisma.config.ts
docker-compose.yml
```

## License

See [LICENSE](./LICENSE).

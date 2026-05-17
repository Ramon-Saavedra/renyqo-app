# Renyqo Backend

Backend API for Renyqo, a smart rental platform for Germany.

## Stack

- [NestJS](https://nestjs.com/) (Node.js framework)
- TypeScript (strict mode)
- PostgreSQL 16 via Docker
- Prisma v7 with `@prisma/adapter-pg` (WASM driver)
- `express-session` + `connect-pg-simple` for HTTP-only cookie sessions
- `passport` + `passport-local` for local auth strategy
- `bcrypt` for password hashing
- `@nestjs/config` + `class-validator` for env and DTO validation

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

Start the database (exposes PostgreSQL on port **5433** to avoid conflicts with a local PostgreSQL on 5432):

```bash
docker compose up -d
```

Run the initial migration:

```bash
npx prisma migrate dev --name init
```

Start the server:

```bash
npm run start:dev
```

## Environment variables

| Variable         | Required | Description                                           |
| ---------------- | -------- | ----------------------------------------------------- |
| `NODE_ENV`       | yes      | One of `development`, `production`, `test`            |
| `PORT`           | yes      | TCP port for the HTTP server (1–65535)                |
| `DATABASE_URL`   | yes      | PostgreSQL connection string                          |
| `SESSION_SECRET` | yes      | Secret for session signing (min 32 characters)        |

Values are validated at startup; the application fails fast with a clear error if any are missing or invalid.

## API

Global prefix: `/api/v1`

### Health

| Method | Path             | Auth | Description              |
| ------ | ---------------- | ---- | ------------------------ |
| `GET`  | `/api/v1/health` | —    | Liveness probe           |

### Auth

| Method | Path                    | Auth         | Body                                                                  | Description                    |
| ------ | ----------------------- | ------------ | --------------------------------------------------------------------- | ------------------------------ |
| `POST` | `/api/v1/auth/register` | —            | `name`, `email`, `password`, `role`, `acceptedTerms`, `acceptedPrivacy` | Register as applicant/provider |
| `POST` | `/api/v1/auth/login`    | —            | `email`, `password`                                                   | Login, sets `sid` cookie       |
| `POST` | `/api/v1/auth/logout`   | 🔒 Session  | —                                                                     | Logout, clears `sid` cookie    |
| `GET`  | `/api/v1/auth/me`       | 🔒 Session  | —                                                                     | Returns current user (no hash) |

**Allowed roles at registration:** `applicant`, `provider`. Admin registration is internal only.

Sessions use an HTTP-only cookie (`sid`) stored in a PostgreSQL table (`user_sessions`).

### Me

| Method | Path                              | Auth        | Description                              |
| ------ | --------------------------------- | ----------- | ---------------------------------------- |
| `GET`  | `/api/v1/me/onboarding-state`     | 🔒 Session | Returns role-based onboarding state      |

**Response for `provider`:**
```json
{
  "role": "provider",
  "hasCreatedFirstListing": false,
  "nextStep": "create_first_listing"
}
```

**Response for `applicant`:**
```json
{
  "role": "applicant",
  "nextStep": "applicant_area_pending"
}
```

### Listings (Provider only 🔒)

| Method   | Path                                   | Auth             | Body / Params                    | Description                                      |
| -------- | -------------------------------------- | ---------------- | -------------------------------- | ------------------------------------------------ |
| `POST`   | `/api/v1/listings`                     | 🔒 Provider     | `CreateListingDto`               | Create a new listing (status: DRAFT)             |
| `GET`    | `/api/v1/listings`                     | 🔒 Provider     | —                                | Get all listings owned by the authenticated provider |
| `GET`    | `/api/v1/listings/:id`                 | 🔒 Provider     | `:id` (UUID)                     | Get a single listing by ID (ownership enforced)  |
| `PATCH`  | `/api/v1/listings/:id`                 | 🔒 Provider     | `UpdateListingDto` (all optional)| Update a listing                                 |
| `DELETE` | `/api/v1/listings/:id`                 | 🔒 Provider     | `:id` (UUID)                     | Delete a listing                                 |
| `POST`   | `/api/v1/listings/:id/publish`         | 🔒 Provider     | `:id` (UUID)                     | Publish listing (validates required fields)      |
| `POST`   | `/api/v1/listings/:id/move-to-draft`   | 🔒 Provider     | `:id` (UUID)                     | Move a published listing back to DRAFT           |

**Required fields to publish:** `title`, `street`, `livingArea`, `rooms`, `bedrooms`, `coldRent`, `availableFrom`.

**Listing statuses:** `DRAFT`, `PUBLISHED`, `ARCHIVED`.

**Enums:** `ObjectType` (`APARTMENT`, `HOUSE`, `ROOM`, `STUDIO`, `SHARED_ROOM`, `COMMERCIAL`), `PetsPolicy` (`ALLOWED`, `NOT_ALLOWED`, `NEGOTIABLE`), `SmokingPolicy` (`ALLOWED`, `NOT_ALLOWED`, `BALCONY_ONLY`).

## Scripts

| Script                  | Purpose                                    |
| ----------------------- | ------------------------------------------ |
| `npm run start`         | Start the server                           |
| `npm run start:dev`     | Start in watch mode                        |
| `npm run start:prod`    | Start the compiled build                   |
| `npm run build`         | Compile to `dist/`                         |
| `npm run lint`          | Run ESLint                                 |
| `npm run format`        | Format sources with Prettier               |
| `npm run format:check`  | Check formatting without writing           |
| `npm run typecheck`     | Run TypeScript without emitting files      |
| `npm run test`          | Run unit tests                             |
| `npm run test:e2e`      | Run end-to-end tests                       |
| `npm run test:cov`      | Run tests with coverage                    |

## Project structure

```
src/
  __mocks__/            Jest module mocks (e.g., prisma-client.mock.ts for unit tests)
  auth/
    dto/              RegisterDto, LoginDto
    guards/           LocalAuthGuard, AuthenticatedGuard
    serializers/      SessionSerializer (serialize/deserialize by user ID)
    strategies/       LocalStrategy (passport-local, usernameField: email)
    auth.controller.ts
    auth.module.ts
    auth.service.ts
    auth.service.spec.ts
  common/
    guards/           ProviderOnlyGuard (requires authenticated + PROVIDER role)
    types/            express.d.ts (Express.User type augmentation)
  config/             Environment validation (EnvironmentVariables, validateEnv)
  generated/
    prisma/           Auto-generated Prisma client (gitignored)
  health/             Health module (controller, service)
  me/
    types/            OnboardingState discriminated union type
    me.controller.ts
    me.module.ts
    me.service.ts
    me.service.spec.ts
  listings/
    dto/              CreateListingDto, UpdateListingDto
    listings.controller.ts
    listings.module.ts
    listings.service.ts
    listings.service.spec.ts
  prisma/             PrismaService (global), PrismaModule
  users/
    types/            SafeUser type (User without passwordHash)
    users.module.ts
    users.service.ts
    users.service.spec.ts
  app.module.ts       Root module
  main.ts             Bootstrap (global prefix, validation pipe, session, passport)
prisma/
  schema.prisma       Data model (User, Listing, Role, UserStatus, ListingStatus, ObjectType, PetsPolicy, SmokingPolicy enums, snake_case column maps, UUID primary keys)
prisma.config.ts      Prisma v7 datasource config (DATABASE_URL)
docker-compose.yml    PostgreSQL 16-alpine with healthcheck and restart policy
test/                 End-to-end test setup
```

## Security notes

- Passwords hashed with bcrypt (cost 12). `passwordHash` is never returned in API responses.
- Sessions stored in PostgreSQL (`user_sessions`) via `connect-pg-simple`. Cookie: HTTP-only, `SameSite=Lax`, secure in production.
- `validateUser` always runs `bcrypt.compare` even when the user does not exist (timing attack mitigation).
- Email is normalized to lowercase + trimmed on register and login.
- Duplicate email on register is detected via PostgreSQL unique constraint (P2002) to avoid TOCTOU race conditions.
- Public registration is restricted to `applicant` and `provider` roles. Admin accounts are internal only.
- Trust proxy is enabled only in `NODE_ENV=production` for correct cookie `Secure` flag behavior behind a reverse proxy.

## License

See [LICENSE](./LICENSE).

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

## Getting Started

```bash
git clone https://github.com/Ramon-Saavedra/renyqo-app.git
cd renyqo-app
npm install
cp .env.example .env
```

Fill the required values in `.env`. `SESSION_SECRET` must be at least 32 characters. OpenAI variables are required for the API to start. `FRONTEND_URL` is required in production. Cloudinary credentials are required in production and for local listing image uploads.

Start PostgreSQL:

```bash
docker compose up -d
```

Run database migrations:

```bash
npx prisma migrate dev
```

Queue-related migrations require a maintenance window in deployment. See [Database](docs/database.md).

Generate the Prisma client:

```bash
npx prisma generate
```

Start the API:

```bash
npm run start:dev
```

## Environment

Copy `.env.example` to `.env` and set the values for this machine. Names, required flags, and descriptions are in [Database](docs/database.md#environment-variables). Production and upload credential rules are documented in [Security](docs/security.md).

## Scripts

| Script                                | Purpose                       |
| ------------------------------------- | ----------------------------- |
| `npm run start:dev`                   | Start in watch mode           |
| `npm run build`                       | Compile to `dist/`            |
| `npm run lint`                        | Run ESLint                    |
| `npm run format`                      | Format source files           |
| `npm run format:check`                | Check source formatting       |
| `npm run typecheck`                   | TypeScript check without emit |
| `npm run test`                        | Run unit tests                |
| `npm run test:e2e`                    | Run end-to-end tests          |
| `npm run test:e2e:listing-assistance` | Run Listing AI HTTP tests     |
| `npm run test:cov`                    | Run tests with coverage       |
| `npm run eval:listing-assistance`     | Run live Listing AI evals     |
| `npm run audit:prod`                  | Audit production dependencies |

## Testing

Unit tests:

```bash
npm test
```

End-to-end tests need a dedicated PostgreSQL database. Setup, safety checks, and local Docker commands are in [Database](docs/database.md#e2e-testing).

Live Listing AI evals (`npm run eval:listing-assistance`) use the configured OpenAI API and may incur cost. Standard CI tests use typed stubs and do not call OpenAI. See [API](docs/api.md#ai-assisted-listing-extraction).

### Quality Gate

Before shipping backend changes:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

## Project Structure

```txt
src/
  applicant-listing-actions/    Applicant saved listings and reports
  applicant-listing-summaries/  Applicant-safe listing summaries
  applicant-profile/            Applicant profile used for eligibility
  applications/                 Listing applications
  auth/                         Session-based auth
  common/                       Shared guards and types
  config/                       Environment validation
  dashboard/                    Provider dashboard summary
  eligibility/                  Explainable listing eligibility
  email/                        Amazon SES email delivery
  health/                       Liveness endpoint
  listing-assistance/           Provider-only AI listing extraction
  listing-images/               Cloudinary-backed listing images
  listings/                     Provider listing management
  me/                           Current-user onboarding state
  prisma/                       Prisma service
  published-listings/           Published listing access
  saved-listings/               Saved listing persistence
  security/                     CSRF protection
  users/                        User service and safe user mapping
prisma/
  migrations/
  schema.prisma
docker-compose.yml
docker-compose.e2e.yml
```

## Documentation

- [API](docs/api.md)
- [Application lifecycle](docs/application-lifecycle.md)
- [Security](docs/security.md)
- [Database](docs/database.md)

## Docker

```bash
docker build -t renyqo-backend .
docker run --env-file .env -p 3000:3000 renyqo-backend
```

The production container runs `node dist/main` with production dependencies only. It requires the same environment variables as `.env.example`. The GitHub Actions image smoke test is documented in [Security](docs/security.md#docker-ci).

## License

See [LICENSE](./LICENSE).

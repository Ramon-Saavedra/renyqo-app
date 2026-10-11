# Renyqo Backend

Renyqo is a rental platform for the German market. This repository is its HTTP API.

Providers publish listings. Applicants discover published listings, compare them with their profile, and apply. The API then controls admission, a bounded active queue, provider decisions, one text conversation per application, requested documents, and viewings.

## Architecture

- NestJS modules, REST under `/api/v1`, TypeScript strict
- PostgreSQL 16 through Prisma ORM 7 and `@prisma/adapter-pg`
- Server-side sessions stored in PostgreSQL
- One codebase, two processes: the HTTP API and a document-verdict worker
- Node.js 22 production image; local PostgreSQL from Docker Compose

Document verdict path:

```text
Applicant upload → S3 → GuardDuty → EventBridge → SQS → NestJS worker → PostgreSQL finalization
```

The worker does not scan files. GuardDuty does. EventBridge delivers the scan result, and tagging-failure events, to an encrypted queue. The worker publishes a file only after a clean verdict for that exact object version. A separate recovery pass rechecks overdue processing attempts. See [Application documents](docs/application-documents.md).

## Decisions

- Sessions use `express-session`, `connect-pg-simple`, `passport`, and `passport-local`. Passwords are hashed with `bcrypt`. Public registration accepts only `applicant` and `provider`.
- State-changing requests require the session CSRF token and an `Origin` or `Referer` that matches `FRONTEND_URL`.
- Lifecycle changes, conversations, documents, and viewings share listing-before-application locks and Serializable transactions. Activity and listing events are append-only.
- Eligibility compares the applicant profile with the listing rules and returns reasons. It does not produce a score.
- Listing assistance sends provider text, PDF, or audio to OpenAI and returns a structured listing draft. CI uses typed stubs. Live evals are a separate script.
- Attention counts and workspace capabilities are derived from current domain rows. There is no stored badge table.

## Infrastructure in this repository

- `docker-compose.yml` runs PostgreSQL 16 for local development.
- `docker-compose.e2e.yml` provides the database used by end-to-end tests.
- `Dockerfile` builds an image that runs `node dist/main` as a non-root user.
- GitHub Actions runs format, lint, typecheck, unit tests, build, production dependency audit, CodeQL, dependency review, Prisma checks, end-to-end tests, and an image smoke test of `/api/v1/health`. The image check does not deploy.
- `infra/application-documents.yaml` defines the private document bucket, GuardDuty plan, EventBridge rule, encrypted SQS queues, and scoped policies in `eu-central-1`. It does not create API or worker compute. Production document uploads require the Prisma migration and the CloudFormation template at `infra/application-documents.yaml`. Files stay inaccessible until the worker finalizes a clean verdict. The API returns 503 when document storage configuration is incomplete.
- Listing images use Cloudinary. Password-reset email uses Amazon SES.

## Application process

- Viewings use immutable proposal rounds, applicant change requests, audited attendance corrections, and final interest. Group viewings may overlap across applications. See [Application viewings](docs/application-viewings.md).
- A manual `NOT_SELECTED` rejection imposes a 720-hour re-submission cooldown. Eligibility recovery allows a fresh attempt without that cooldown. Successful provider restoration cancels the cooldown for that attempt. See [Application lifecycle](docs/application-lifecycle.md).
- Recent exits show the newest terminal attempt of each previously active applicant who is currently out of the process. See [Provider recent exits](docs/application-lifecycle.md#provider-recent-exits).
- Attention APIs derive pending actions and unread counts per audience. See [Application attention](docs/application-attention.md).
- Read models return listing overviews, applicant cards, and workspaces from one database snapshot. Activity and document history stay paginated. See [Application read models](docs/application-read-models.md).
- Each application has one text conversation, opened by the provider's first message. See [Application conversations](docs/api.md#application-conversations).

## Follow-ups documented in the repository

- Document retention and deletion, including identity documents and SCHUFA files, is not implemented. See [Application documents](docs/application-documents.md).
- Configured rate limits are stored in memory per process. They are not shared across replicas. See [Security](docs/security.md#rate-limits).
- Listing-event history is retained for a later full listing timeline. That timeline is not a module here. See [Application lifecycle](docs/application-lifecycle.md).

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

The `test/tsconfig.json` configuration extends the shared test configuration so editors resolve Jest globals in E2E files. Production compilation keeps Jest types excluded. Run `npm run typecheck` to validate production, test and evaluation configurations.

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
  application-attention/        Derived pending actions and unread totals
  application-conversation/     Application text conversations and messages
  application-documents/        Requested documents, S3 uploads and scan worker
  application-read-models/      Compact overviews and application workspaces
  application-viewings/         Viewing proposals, outcomes and interest
  applications/                 Listing applications
  auth/                         Session-based auth
  common/                       Shared guards and types
  config/                       Environment validation
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
- [Application viewings](docs/application-viewings.md)
- [Application attention](docs/application-attention.md)
- [Application read models](docs/application-read-models.md)
- [Application documents](docs/application-documents.md)
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

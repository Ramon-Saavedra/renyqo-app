# Database

The API uses PostgreSQL 16 and Prisma ORM v7 with `@prisma/adapter-pg`.

## Environment variables

Copy `.env.example` to `.env`. Names and local defaults are listed there.

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

`E2E_DATABASE_URL` and `E2E_DATABASE_ALLOW_RESET` are required for end-to-end tests. See [E2E Testing](#e2e-testing).

Production deployments should configure an approved, dated OpenAI model snapshot for `OPENAI_LISTING_MODEL` when the selected model family offers snapshots. Model changes require the same eval and review process as code changes. See [API](api.md#ai-assisted-listing-extraction).

## Local setup

Start PostgreSQL:

```bash
docker compose up -d
```

`DATABASE_URL` is required. The local Compose default is documented in `.env.example`.

Run database migrations:

```bash
npx prisma migrate dev
```

Generate the Prisma client:

```bash
npx prisma generate
```

## Migrations

The application queue migrations add and backfill a global FIFO sequence and build queue indexes. Run them during a deployment maintenance window with application writes stopped; the backfill and index creation are intentionally not online operations.

Existing applicant profiles with incomplete household counts are cleaned up: rows with both `adultsCount` and `childrenCount` get `peopleCount` recalculated; ambiguous rows are cleared. A database constraint prevents future invalid states.

`adultsCount` and `childrenCount` must be provided together or neither. When both are present, `peopleCount` is calculated as `adultsCount + childrenCount`. The database enforces this with a `CHECK` constraint, and the service validates merged state inside a Serializable transaction with retries.

## Indexes

Listing discovery sort modes are supported by these indexes:

`(status, publishedAt, id)`, `(status, coldRent, id)`, `(status, livingArea, id)` and `(status, availableFrom)`.

## Transactions and concurrency

Public listing collection `total` and page are calculated in a consistent Repeatable Read transaction.

Waiting-queue promotion, apply, withdraw, reject, restore, and rent run in Serializable transactions with row locks and serialization-conflict retries where documented in [Application lifecycle](application-lifecycle.md). Concurrent promotions can never exceed five `ACTIVE` applications. Withdrawing an `ACTIVE` application keeps slot release and FIFO promotion atomic in the same Serializable transaction.

`DELETE` of a listing image removes the image record and compacts the remaining positions in one transaction, then deletes the Cloudinary asset. If the database transaction fails, the Cloudinary asset is kept untouched; if the Cloudinary deletion fails afterwards, the failure is logged and the image stays removed.

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

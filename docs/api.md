# API

Global prefix: `/api/v1`

State-changing requests (`POST`, `PUT`, `PATCH`, and `DELETE`) must send the session-bound token from `/api/v1/auth/csrf-token` in the `X-CSRF-Token` header. Session, CSRF, origin, and ownership rules are documented in [Security](security.md). Application status, queue, and rent rules are documented in [Application lifecycle](application-lifecycle.md).

## Health

| Method | Path             | Auth | Description    |
| ------ | ---------------- | ---- | -------------- |
| `GET`  | `/api/v1/health` | No   | Liveness probe |

## Auth

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

Provider registration may also include optional identity fields:

- `providerType`: `private` or `company`
- `companyName`: required when `providerType` is `company`

If `providerType` is omitted, both `providerType` and `companyName` remain `null` for backwards compatibility. If `providerType` is `private`, `companyName` is stored as `null`.

Safe user responses from `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, and `GET /api/v1/auth/me` include `name`, `email`, `providerType`, and `companyName`, but never `passwordHash`.

Password recovery uses Amazon SES. `POST /api/v1/auth/forgot-password` always returns a neutral response whether the email exists or not. Reset tokens are generated securely, stored only as hashes, expire after 60 minutes, and are single-use. A successful reset updates the stored password hash and invalidates existing sessions.

## Me

| Method | Path                          | Auth    | Description                        |
| ------ | ----------------------------- | ------- | ---------------------------------- |
| `GET`  | `/api/v1/me/onboarding-state` | Session | Return role-based onboarding state |

## Public Listing Discovery

These public endpoints return only PUBLISHED listings with a publication date. Registration is not required.

| Method | Path                   | Auth          | Description                                                           |
| ------ | ---------------------- | ------------- | --------------------------------------------------------------------- |
| `GET`  | `/api/v1/listings`     | Public (opt.) | Browse published listings with filters, sorting and cursor pagination |
| `GET`  | `/api/v1/listings/:id` | Public (opt.) | Get public detail for a published listing                             |

Authentication is optional. When a valid applicant session is present, listing responses include a `profileMatch` value calculated from the applicant profile and listing requirements. Anonymous requests and providers receive `profileMatch: "UNKNOWN"`.

For active applicants, both collection and detail responses expose application state:

- `hasApplied`: `true` when the applicant has a blocking application for the listing (`ACTIVE`, `WAITING`, `REJECTED`, or `ACCEPTED`); otherwise `false` (including no application or only `WITHDRAWN`)
- `applicationStatus`: the blocking application status, or `null` when there is no blocking application
- `publicReason`: authoritative rejection reason when `applicationStatus` is `REJECTED`; otherwise `null`
- `isSaved`: `true` when the authenticated active applicant has saved the listing; otherwise `false`. Anonymous requests, providers and non-active applicants always receive `false` without querying saved listings.

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

Collection response items include:

- `district`, `publishedAt`, `isNew` (true within the first 7 days after `publishedAt`, computed server-side per-request)
- `petsPolicy` at the item level
- `profileMatch`: `MATCH`, `NO_MATCH`, `PROFILE_INCOMPLETE` or `UNKNOWN`
- `hasApplied`, `applicationStatus`, `publicReason` (see application state above)
- `isSaved` (see application state above)
- narrow public summary with `coverImage` containing only `secureUrl`
- never exposes `providerId`, `showExactAddress`, Cloudinary `publicId`, applicant profile values, eligibility reasons or warnings

Detail response (`ApplicantListingDetailDto`) includes `district`, `isNew`, `profileMatch`, `hasApplied`, `applicationStatus`, `publicReason` and `isSaved` at the top level. `requirements.petsPolicy` is preserved in the nested requirements object and is not duplicated at the top level.

Personalized responses (any request carrying a valid applicant session) use `Vary: Cookie` and `Cache-Control: private, no-store, must-revalidate` to prevent shared-cache leakage of applicant-specific data.

DRAFT, PAUSED, ARCHIVED and RENTED listings are not accessible through these endpoints.

## Provider Listings

Provider endpoints require an authenticated provider session and enforce listing ownership.

| Method  | Path                                    | Auth     | Description                                             |
| ------- | --------------------------------------- | -------- | ------------------------------------------------------- |
| `POST`  | `/api/v1/provider/listings`             | Provider | Create a draft listing, optionally with its first image |
| `GET`   | `/api/v1/provider/listings`             | Provider | Get all owned listings with `activeApplicationsCount`   |
| `GET`   | `/api/v1/provider/listings/:id`         | Provider | Get one owned listing                                   |
| `PATCH` | `/api/v1/provider/listings/:id`         | Provider | Update an owned listing                                 |
| `PATCH` | `/api/v1/provider/listings/:id/publish` | Provider | Publish an owned listing                                |
| `PATCH` | `/api/v1/provider/listings/:id/draft`   | Provider | Move a listing back to draft                            |
| `PATCH` | `/api/v1/provider/listings/:id/archive` | Provider | Archive an owned listing                                |
| `PATCH` | `/api/v1/provider/listings/:id/rent`    | Provider | Mark a listing as rented and finalize applications      |

`GET /api/v1/provider/listings/:id/active-applications` is documented under [Applications](#applications).

`GET /api/v1/provider/listings` returns every listing owned by the authenticated provider, ordered by `createdAt` descending. Each item includes `activeApplicationsCount`: the authoritative number of applications with status `ACTIVE` for that listing (expected domain `0`–`5`). WAITING and other non-ACTIVE statuses are not counted. The response does not expose applicant identities, profiles, or raw Prisma `_count` objects.

Required property fields to publish: `street`, `zip`, `city`, `livingArea`, `rooms`, `bedrooms`, `coldRent`, `availableFrom`. A final `title` is also required; the frontend sends either its Provider override or its deterministic auto-title.

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

## AI-Assisted Listing Extraction

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

Production OpenAI model snapshot policy is documented in [Database](database.md#environment-variables).

## Listing Images

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

## Applications

| Method   | Path                                                | Auth      | Description                                                         |
| -------- | --------------------------------------------------- | --------- | ------------------------------------------------------------------- |
| `GET`    | `/api/v1/listings/:id/eligibility`                  | Applicant | Read explainable eligibility for the current applicant              |
| `POST`   | `/api/v1/listings/:id/apply`                        | Applicant | Apply to a published listing                                        |
| `GET`    | `/api/v1/applicant/applications`                    | Applicant | Get applications submitted by the current applicant                 |
| `DELETE` | `/api/v1/applicant/applications/:id`                | Applicant | Withdraw one owned application                                      |
| `GET`    | `/api/v1/provider/applications`                     | Provider  | Get applications across provider listings                           |
| `GET`    | `/api/v1/provider/listings/:id/applications`        | Provider  | Get applications for an owned listing                               |
| `GET`    | `/api/v1/provider/listings/:id/active-applications` | Provider  | Get ACTIVE applications with provider-safe applicant summaries      |
| `GET`    | `/api/v1/provider/listings/:id/exited-applications` | Provider  | Get REJECTED and WITHDRAWN applications that were previously ACTIVE |
| `GET`    | `/api/v1/provider/listings/:id/waiting-count`       | Provider  | Get the waiting application count for an owned listing              |
| `PATCH`  | `/api/v1/provider/applications/:id/reject`          | Provider  | Reject one owned ACTIVE application                                 |
| `PATCH`  | `/api/v1/provider/applications/:id/restore`         | Provider  | Restore one owned REJECTED + NOT_SELECTED application               |

`GET /api/v1/provider/listings/:id/active-applications` returns at most five `ACTIVE` applications for an owned listing, ordered internally by `createdAt` ascending. Each item contains only `id`, `listingId`, `status`, `activeAt`, and a nested `applicant` summary with `name`, nullable `peopleCount`, and the nullable Phase 1 `introduction`. The introduction is trimmed plain text with a maximum of 250 characters; legacy profiles may return `null` until the applicant updates their profile. It never includes `WAITING` applications, applicant identifiers, email, household income, income proof, SCHUFA, household breakdowns, pets, smoking, rejection metadata, `queueOrder`, password hashes, or unrelated user fields.

`GET /api/v1/provider/listings/:id/exited-applications` returns a summary for an owned listing of applications that were `ACTIVE` at some point (`activeAt` is set) and have since become `REJECTED` or `WITHDRAWN`. Applications that withdrew or were re-applied while still `WAITING` never had `activeAt` set and are excluded. The response is `{ items: ProviderExitedApplicationResponseDto[], totalCount: number }`. `items` contains at most five exits ordered by `exitedAt` descending (newest first), where `exitedAt` is `withdrawnAt` for `WITHDRAWN` rows and `rejectedAt` for `REJECTED` rows. `totalCount` is the total number of matching exited applications for the listing. Each item contains `id`, `listingId`, `applicantName`, `status`, `publicReason`, `activeAt`, and `exitedAt`, plus nullable `peopleCount` and `introduction` for the limited Applicant preview. `activeAt` is the entry into the most recent `ACTIVE` period, with the same meaning as on `active-applications`. Legacy profiles with no profile data or no introduction return `null` for the respective field. `introduction` is trimmed plain text with a maximum of 250 characters. The endpoint never exposes applicant identifiers, email, household income, income proof, SCHUFA, household breakdowns, pets, smoking, assets, religion or origin, ranking or scoring, eligibility internals, `queueOrder`, password hashes, or unrelated user/profile fields.

`GET /api/v1/listings/:id/eligibility` is read-only, takes no request body, and returns `canApply`, `reasons`, `warnings` and `evaluatedAt`. Eligibility authority is documented in [Application lifecycle](application-lifecycle.md#eligibility-authority).

`GET /api/v1/applicant/applications` returns every application row submitted by the current applicant, ordered by `createdAt` descending (newest first). Because re-applying after withdrawal creates a new row, the response may legitimately contain multiple rows with the same `listingId`. The frontend should treat the most recent row for a given listing as the current application state; if that row is `ACTIVE` or `WAITING` it is the live application, otherwise the listing has no live application. The response never exposes queue position, provider identity, private address, internal eligibility data or provider comments.

Apply, withdraw, reject, restore, rent, waiting-queue, and terminal-state rules are documented in [Application lifecycle](application-lifecycle.md).

## Applicant Listing Actions

Authenticated active applicants can save listings and report published listings. These actions never modify listing status and do not expose reporter identity.

| Method   | Path                                           | Auth      | Description                           |
| -------- | ---------------------------------------------- | --------- | ------------------------------------- |
| `PUT`    | `/api/v1/applicant/listings/:listingId/saved`  | Applicant | Save a published listing (idempotent) |
| `DELETE` | `/api/v1/applicant/listings/:listingId/saved`  | Applicant | Remove a saved listing (idempotent)   |
| `GET`    | `/api/v1/applicant/saved-listings`             | Applicant | List saved published listings         |
| `POST`   | `/api/v1/applicant/listings/:listingId/report` | Applicant | Report a published listing            |

Saving requires a publicly available published listing. Unsaving is idempotent and does not require the listing to remain published. `PUT` and `DELETE` return `{ saved: boolean, savedAt: string | null }`.

`GET /api/v1/applicant/saved-listings` returns the authenticated active applicant's saved listings as the same applicant-safe summary contract used by discovery (`items`, `nextCursor`, `total`). Results include only published listings; saved rows for paused, archived or rented listings remain persisted but are omitted from the response. Items are ordered by newest save first. Every returned item has `isSaved: true`. Cursor pagination uses `limit` (default `20`, max `50`) and optional `cursor`.

`POST /api/v1/applicant/listings/:listingId/report` accepts `reason` (`MISLEADING_INFO`, `SCAM_OR_FRAUD`, `DISCRIMINATION`, `INAPPROPRIATE_CONTENT`, `DUPLICATE_OR_SPAM`, `OTHER`) and optional `detail` (max 500 characters, trimmed; empty becomes `null`). `OTHER` requires a non-empty `detail`. One report per applicant and listing; duplicates return `409`. The response exposes only `id`, `listingId`, `reason` and `createdAt`.

Report rate limit: five reports per hour per authenticated applicant (`429`, `code: "LISTING_REPORT_RATE_LIMITED"`). The in-memory throttler storage applies per backend process.

## Applicant Profile

| Method  | Path                        | Auth      | Description                                    |
| ------- | --------------------------- | --------- | ---------------------------------------------- |
| `GET`   | `/api/v1/applicant/profile` | Applicant | Get the applicant profile, or `404` if missing |
| `PATCH` | `/api/v1/applicant/profile` | Applicant | Create or update the applicant profile         |

**PATCH contract:**

- Omitted fields retain their existing value.
- `null` explicitly clears a field.
- `introduction` is required when creating a profile and when updating a legacy profile whose introduction is `null`.
- `introduction` must be trimmed, non-empty, plain text, and no longer than 250 characters. It cannot be cleared with `null`.
- An empty body returns `400`.
- `peopleCount` is read-only and derived by the backend; submitting it returns `400`.

**Household invariant:**

`adultsCount` and `childrenCount` must be provided together or neither. When both are present, `peopleCount` is calculated as `adultsCount + childrenCount`. The database enforces this with a `CHECK` constraint, and the service validates merged state inside a Serializable transaction with retries. See [Database](database.md).

**Response:**

Both `GET` and `PATCH` return only business fields:

```text
householdNetIncome, incomeProofAvailable, schufaAvailable,
peopleCount, adultsCount, childrenCount,
hasPets, isSmoker, introduction
```

During the Phase 1 migration, `introduction` may be `null` for legacy profiles. New profiles and updated legacy profiles always persist a real introduction. Internal identifiers and timestamps are not exposed.

## Dashboard

| Method | Path                                 | Auth     | Description                      |
| ------ | ------------------------------------ | -------- | -------------------------------- |
| `GET`  | `/api/v1/provider/dashboard/summary` | Provider | Summary of the provider listings |

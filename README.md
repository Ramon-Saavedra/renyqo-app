# Renyqo Backend

Backend API for Renyqo, a smart rental platform for Germany.

## Stack

- [NestJS](https://nestjs.com/) (Node.js framework)
- TypeScript (strict mode)
- `@nestjs/config` for environment loading
- `class-validator` + `class-transformer` for env and DTO validation

## Requirements

- Node.js 20+
- npm 10+

## Setup

```bash
git clone https://github.com/Ramon-Saavedra/renyqo-app.git
cd renyqo-app
npm install
cp .env.example .env
```

## Environment variables

| Variable   | Required | Description                                           |
| ---------- | -------- | ----------------------------------------------------- |
| `NODE_ENV` | yes      | One of `development`, `production`, `test`            |
| `PORT`     | yes      | TCP port for the HTTP server (1-65535)                |

Values are validated at startup; the application fails fast with a clear error if any are missing or invalid.

## API

Global prefix: `/api/v1`

| Method | Path               | Description                          |
| ------ | ------------------ | ------------------------------------ |
| `GET`  | `/api/v1/health`   | Liveness probe, returns service status |

## Scripts

| Script                  | Purpose                                    |
| ----------------------- | ------------------------------------------ |
| `npm run start`         | Start the server                           |
| `npm run start:dev`     | Start in watch mode                        |
| `npm run start:prod`    | Start the compiled build                   |
| `npm run build`         | Compile to `dist/`                         |
| `npm run lint`          | Run ESLint with autofix                    |
| `npm run format`        | Format sources with Prettier               |
| `npm run format:check`  | Check formatting without writing           |
| `npm run typecheck`     | Run TypeScript without emitting files      |
| `npm run test`          | Run unit tests                             |
| `npm run test:e2e`      | Run end-to-end tests                       |
| `npm run test:cov`      | Run tests with coverage                    |

## Project structure

```
src/
  config/         Environment validation
  health/         Health module (controller, service)
  app.module.ts   Root module
  main.ts         Bootstrap (global prefix, validation pipe)
test/             End-to-end test setup
```

## License

See [LICENSE](./LICENSE).

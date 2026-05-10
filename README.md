# Renyqo Backend

Backend API for Renyqo, a smart rental platform for Germany.

## Stack

- [NestJS](https://nestjs.com/) (Node.js framework)
- TypeScript (strict mode)

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
src/        Application source
test/       End-to-end test setup
```

## License

See [LICENSE](./LICENSE).

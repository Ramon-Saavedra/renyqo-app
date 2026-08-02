const E2E_DATABASE_NAME = 'renyqo_e2e';

function isSafeE2EDatabaseName(name: string): boolean {
  return name.toLowerCase() === E2E_DATABASE_NAME;
}

export function getE2EDatabaseName(databaseUrl: string): string {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    throw new Error('E2E_DATABASE_URL must be a valid PostgreSQL URL.');
  }

  const databaseName = decodeURIComponent(parsedUrl.pathname)
    .split('/')
    .filter(Boolean)
    .at(-1);

  if (!databaseName || !isSafeE2EDatabaseName(databaseName)) {
    throw new Error(
      `Destructive E2E cleanup requires a database named "${E2E_DATABASE_NAME}".`,
    );
  }

  return databaseName;
}

export function assertSafeE2EDatabaseUrl(databaseUrl: string): void {
  getE2EDatabaseName(databaseUrl);
}

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

  if (!databaseName || !databaseName.toLowerCase().endsWith('_e2e')) {
    throw new Error(
      'Destructive E2E cleanup requires a database name ending with "_e2e".',
    );
  }

  return databaseName;
}

export function assertSafeE2EDatabaseUrl(databaseUrl: string): void {
  getE2EDatabaseName(databaseUrl);
}

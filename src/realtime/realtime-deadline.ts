// Bounds read-only lookups and prevents a timed-out publisher from emitting later.
export const REALTIME_OPERATION_TIMEOUT_MS = 5000;

export async function withRealtimeDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const operationPromise = operation(controller.signal);
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      operationPromise.catch(() => undefined);
      reject(new Error('Realtime operation timed out'));
    }, REALTIME_OPERATION_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operationPromise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

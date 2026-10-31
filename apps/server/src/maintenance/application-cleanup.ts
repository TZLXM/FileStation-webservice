export interface CloseableResource {
  close(): Promise<void>;
}

function preserveCleanupFailure(
  originalError: unknown,
  cleanupError: unknown,
): void {
  if (!(originalError instanceof Error) || originalError.cause !== undefined) {
    return;
  }
  try {
    Object.defineProperty(originalError, 'cause', {
      configurable: true,
      value: cleanupError,
      writable: true,
    });
  } catch {
    // Cleanup diagnostics must never replace the original startup failure.
  }
}

export async function closeResourceAfterFailure(
  resource: CloseableResource,
  originalError: unknown,
): Promise<unknown | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => resource.close()),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('startup cleanup timed out')), 10_000); }),
    ]);
    return undefined;
  } catch (cleanupError) {
    preserveCleanupFailure(originalError, cleanupError);
    return cleanupError;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runWithCleanupOnFailure<T>(
  resource: CloseableResource,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    await closeResourceAfterFailure(resource, error);
    throw error;
  }
}

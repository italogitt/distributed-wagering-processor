/** Espera `ms`, ou menos se o `signal` abortar antes. Nunca rejeita. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** `true` se a promise terminar dentro do prazo. */
export async function settlesWithin(promise: Promise<unknown> | undefined, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([Promise.resolve(promise).then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

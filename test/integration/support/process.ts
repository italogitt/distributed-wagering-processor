import { TEST_DATABASE_URL } from './env';
import { waitUntil } from './sqs';

/** Variáveis de ambiente valem só durante `fn` (a config é lida ao criar a app). */
export async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export interface SpawnedApp {
  process: ReturnType<typeof Bun.spawn>;
  /** Linhas JSON do stdout (os logs do Nest, que não são JSON, ficam de fora). */
  logs(): Array<Record<string, unknown>>;
  /** Espera o processo terminar (por sinal ou saída normal). */
  exited(): Promise<void>;
}

/**
 * Sobe a app de verdade num processo filho (`bun src/main.ts`) no banco desta
 * execução, e espera aparecerem os logs `readyMessages` (ex.: "sqs consumer started").
 */
export async function spawnApp(env: Record<string, string>, readyMessages: string[]): Promise<SpawnedApp> {
  const child = Bun.spawn(['bun', 'src/main.ts'], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, PORT: '0', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const lines: Array<Record<string, unknown>> = [];
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        try {
          lines.push(JSON.parse(part));
        } catch {
          // log do Nest em texto
        }
      }
    }
  })();
  await waitUntil(
    async () => readyMessages.every((message) => lines.some((l) => l.message === message)),
    Boolean,
    { timeoutMs: 10_000 },
  );
  return {
    process: child,
    logs: () => lines,
    exited: async () => {
      await child.exited;
    },
  };
}

export type LogFields = Record<string, unknown>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/**
 * Uma linha JSON por evento (seção 12). Quem chama decide os campos: nunca
 * payload financeiro completo, só ids e o resultado.
 */
export class JsonLogger implements Logger {
  constructor(private readonly context: string) {}

  info(message: string, fields: LogFields = {}): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields: LogFields = {}): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields: LogFields = {}): void {
    this.write('error', message, fields);
  }

  private write(level: string, message: string, fields: LogFields): void {
    const line = { time: new Date().toISOString(), level, context: this.context, message, ...fields };
    (level === 'error' ? console.error : console.log)(JSON.stringify(line));
  }
}

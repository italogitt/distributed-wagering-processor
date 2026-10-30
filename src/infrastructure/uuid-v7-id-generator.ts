import type { IdGenerator } from '../application/ports/id-generator';

/** UUIDv7 (D5): ordenável pela data de criação, como nos exemplos do enunciado. */
export class UuidV7IdGenerator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}

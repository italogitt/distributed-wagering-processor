/** Gera ids de entidades e eventos. A infra usa UUIDv7 (D5). */
export interface IdGenerator {
  next(): string;
}

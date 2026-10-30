/** Deduplicação das mensagens da fila, na transação SQL corrente (D15/D16). */
export interface InboxRepository {
  exists(consumer: string, messageId: string): Promise<boolean>;
  /** Lança UniqueViolationError se outra transação já gravou (ou está gravando) o par. */
  add(consumer: string, messageId: string, receivedAt: Date): Promise<void>;
}

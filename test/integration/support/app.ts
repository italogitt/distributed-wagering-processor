import './env';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../../src/app.module';

export interface RunningApp {
  url: string;
  close(): Promise<void>;
}

/** Sobe uma app Nest completa (com o próprio MikroORM e pool) numa porta livre. */
export async function startApp(): Promise<RunningApp> {
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  return { url: await app.getUrl(), close: () => app.close() };
}

export interface TransactionBody {
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

/** O corpo como chega pela rede: strings, não os enums do domínio. */
export interface ApiBody {
  transactionId: string;
  status: string;
  failureCode?: string;
  balance?: { amount: string; currency: string };
  idempotentReplay: boolean;
  error?: string;
  message?: string;
}

export interface ApiResponse {
  status: number;
  body: ApiBody;
}

export async function submit(baseUrl: string, idempotencyKey: string, body: TransactionBody): Promise<ApiResponse> {
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as ApiBody };
}

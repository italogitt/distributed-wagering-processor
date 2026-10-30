import { afterAll, beforeAll, expect, test } from 'bun:test';
import { type RunningApp, startApp } from './support/app';
import { closeDatabase, resetDatabase } from './support/database';

let app: RunningApp;

beforeAll(async () => {
  await resetDatabase();
  app = await startApp();
});

afterAll(async () => {
  await app.close();
  await closeDatabase();
});

test('GET /health/live → 200', async () => {
  const response = await fetch(`${app.url}/health/live`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok' });
});

test('GET /health/ready com Postgres e SQS no ar → 200', async () => {
  const response = await fetch(`${app.url}/health/ready`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok', checks: { postgres: 'up', sqs: 'up' } });
});

test('GET /health/ready com o SQS fora → 503', async () => {
  const previous = process.env.SQS_ENDPOINT;
  process.env.SQS_ENDPOINT = 'http://127.0.0.1:1'; // nada escuta aqui
  const broken = await startApp();
  if (previous === undefined) delete process.env.SQS_ENDPOINT;
  else process.env.SQS_ENDPOINT = previous;
  try {
    const response = await fetch(`${broken.url}/health/ready`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'unavailable', checks: { postgres: 'up', sqs: 'down' } });
  } finally {
    await broken.close();
  }
});

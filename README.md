# Wagering Processor

Carteira (wallet) de cassino que processa apostas de provedores de jogos, por HTTP e por fila SQS.
Saldo, ledger, idempotência e eventos ficam no PostgreSQL, na mesma transação SQL. As decisões estão no [ARCHITECTURE.md](ARCHITECTURE.md).

## Stack

| Item | Versão |
|---|---|
| Bun | 1.x (testado com 1.4.4) |
| TypeScript (modo estrito) | 5.9.3 |
| NestJS (Express) | 12.1.3 |
| MikroORM | 7.2.5 (`@mikro-orm/nestjs` 7.1.0) |
| PostgreSQL | 17 (`postgres:17-alpine`) |
| LocalStack (SQS) | 4.14.0 |
| AWS SDK SQS | 3.1160.0 |
| prom-client | 15.1.3 |

## Pré-requisitos

- Bun 1.x.
- Docker com Docker Compose.
- Portas livres: `5432` (Postgres), `4566` (LocalStack) e `3000` (API).

> **Atenção:** se houver um Postgres instalado na máquina ouvindo em `localhost:5432`, ele atende no lugar do container, e o login `wallet` falha (`role "wallet" does not exist`). Pare o Postgres local antes de subir o projeto.

## Passo a passo

```bash
bun install

# 1. Postgres e LocalStack. O LocalStack cria as filas ao subir:
#    wager-transactions.fifo, wager-transactions-dlq.fifo (maxReceiveCount 5) e wallet-events.fifo
docker compose up -d --wait postgres localstack    # ou: bun run db:up

# 2. Migrations
bun run migration:up

# 3. API (porta 3000). Por padrão sobe só o HTTP.
bun run start

# 4. API + consumer SQS + publisher da outbox + worker do PENDING_REFERENCE
SQS_CONSUMER_ENABLED=true OUTBOX_PUBLISHER_ENABLED=true PENDING_REFERENCE_WORKER_ENABLED=true bun run start
```

**LocalStack 4.14.0:** a versão fica fixa porque é a última que roda sem `LOCALSTACK_AUTH_TOKEN`. As versões mais novas exigem token de licença.

## Variáveis de ambiente

Todas têm default para o docker-compose local. Inteiro inválido derruba a app no boot. As flags `*_ENABLED` ligam só com o texto `true`.

| Variável | Default | Para quê |
|---|---|---|
| `PORT` | `3000` | Porta HTTP. |
| `DATABASE_URL` | `postgresql://wallet:wallet@localhost:5432/wallet` | Postgres (app e migrations). |
| `MIKRO_ORM_DEBUG` | — | `true` loga o SQL do MikroORM. |
| `LOG_LEVEL` | — | `silent` cala os logs `info`/`warn` do stdout. Erros continuam no stderr. |
| `AWS_REGION` | `us-east-1` | Região do SQS. |
| `SQS_ENDPOINT` | `http://localhost:4566` | Endpoint do SQS (LocalStack). |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `test` / `test` | Credenciais, usadas quando há endpoint. |
| `SQS_CONSUMER_ENABLED` | `false` | Liga o consumer da fila de apostas. |
| `SQS_CONSUMER_NAME` | `wager-transactions` | Nome do consumer na inbox: `(consumer, messageId)`. |
| `SQS_WAGER_QUEUE_URL` | `.../000000000000/wager-transactions.fifo` | Fila de entrada. O `/health/ready` também confere esta fila. |
| `SQS_WAGER_DLQ_URL` | `.../000000000000/wager-transactions-dlq.fifo` | DLQ das mensagens permanentes. |
| `SQS_WAIT_TIME_SECONDS` | `20` | Long polling do ReceiveMessage. |
| `SQS_VISIBILITY_TIMEOUT_SECONDS` | `30` | Tempo que a mensagem fica invisível durante o processamento. |
| `SQS_MAX_MESSAGES` | `10` | Mensagens por ReceiveMessage. |
| `SQS_BACKOFF_MAX_SECONDS` | `60` | Teto do backoff de erro transitório: `min(2^recebimentos, teto)`. |
| `SQS_SHUTDOWN_TIMEOUT_MS` | `10000` | No SIGTERM, espera pelas mensagens em andamento. |
| `OUTBOX_PUBLISHER_ENABLED` | `false` | Liga o publisher da outbox. |
| `SQS_WALLET_EVENTS_QUEUE_URL` | `.../000000000000/wallet-events.fifo` | Fila dos eventos de integração. |
| `OUTBOX_BATCH_SIZE` | `10` | Eventos por lote. |
| `OUTBOX_POLL_INTERVAL_MS` | `1000` | Espera entre ciclos sem trabalho. |
| `OUTBOX_BACKOFF_MAX_SECONDS` | `60` | Teto do backoff: `min(2^tentativas, teto)`. |
| `OUTBOX_SHUTDOWN_TIMEOUT_MS` | `10000` | No SIGTERM, espera o lote atual. |
| `PENDING_REFERENCE_WORKER_ENABLED` | `false` | Liga o worker do `PENDING_REFERENCE`. |
| `PENDING_REFERENCE_BATCH_SIZE` | `10` | Transações por ciclo (uma transação SQL cada). |
| `PENDING_REFERENCE_POLL_INTERVAL_MS` | `1000` | Espera entre ciclos sem trabalho. |
| `PENDING_REFERENCE_TTL_SECONDS` | `600` | Tempo máximo de espera pela referência. Depois: `REFERENCE_NOT_FOUND`. |
| `PENDING_REFERENCE_BACKOFF_MAX_SECONDS` | `60` | Teto do backoff: `min(2^tentativas, teto)`. |
| `PENDING_REFERENCE_SHUTDOWN_TIMEOUT_MS` | `10000` | No SIGTERM, espera a transação atual. |
| `TEST_DATABASE_URL` | `postgresql://wallet:wallet@localhost:5432/wallet_test` | Só testes: base do nome do banco de cada execução. |

`...` = `http://localhost:4566`.

## Comandos

```bash
bun test                  # testes de unidade (sem Docker)
bun run test:integration  # integração: Postgres e LocalStack reais (precisa do docker compose no ar)
bun run typecheck         # tsc --noEmit
```

Cada execução do `test:integration` cria um banco próprio (`wallet_test_<aleatório>`) e o apaga no fim. Duas execuções ao mesmo tempo não interferem uma na outra, e o banco de dev não é tocado.

## Exemplos (curl)

As respostas abaixo foram copiadas de uma execução real (ids encurtados).

```bash
# Criar wallet → 201
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
# {"id":"01a18dca-...","playerId":"player-1","balance":{"amount":"1000.00","currency":"BRL"},"version":1}

WALLET=01a18dca-...   # o id devolvido acima
BET='{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"player-1",
  "walletId":"'$WALLET'","roundId":"round-987","gameId":"fortune-chimp","kind":"BET",
  "money":{"amount":"25.00","currency":"BRL"}}'

# BET → 200
curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' -d "$BET"
# {"transactionId":"01a18dca-...","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}

# Replay: mesma key e mesmo corpo → mesma resposta, idempotentReplay: true
# Mesma key com outro valor → 409 {"error":"IDEMPOTENCY_CONFLICT",...}

# Consultas
curl -s localhost:3000/wallets/$WALLET
curl -s "localhost:3000/wallets/$WALLET/ledger?limit=50"        # {"walletId":...,"items":[...],"nextCursor":"..."|null}
curl -s "localhost:3000/wallets/$WALLET/ledger?limit=50&cursor=<nextCursor>"
curl -s localhost:3000/wagering/transactions/<transactionId>
curl -s localhost:3000/providers/provider-a/wagering/transactions/transaction-123

# Reconciliação → 200 (só compara; não corrige nada)
curl -s -X POST localhost:3000/wallets/$WALLET/reconciliation
# {"walletId":"...","storedBalance":{"amount":"975.00","currency":"BRL"},"calculatedBalance":{"amount":"975.00","currency":"BRL"},
#  "difference":{"amount":"0.00","currency":"BRL"},"consistent":true,"checkedEntries":2}

# Métricas (formato Prometheus) e health
curl -s localhost:3000/metrics
curl -s localhost:3000/health/live     # {"status":"ok"}
curl -s localhost:3000/health/ready    # {"status":"ok","checks":{"postgres":"up","sqs":"up"}}; 503 se algum cair
```

Pela fila (com `SQS_CONSUMER_ENABLED=true`):

```bash
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id "$WALLET" --message-deduplication-id msg-123 \
  --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z",
    "data":{"providerId":"provider-a","externalTransactionId":"transaction-456","idempotencyKey":"provider-a:transaction-456",
    "playerId":"player-1","walletId":"'$WALLET'","roundId":"round-987","gameId":"fortune-chimp","kind":"BET",
    "money":{"amount":"25.00","currency":"BRL"}}}'
```

## Rodar 3 instâncias

Cada instância é um processo com a sua porta. Todas podem ligar consumer, publisher e worker ao mesmo tempo. A correção vem do banco (UPDATE condicional, índices únicos, inbox e `SKIP LOCKED`), não de qual instância pegou o trabalho.

```bash
export SQS_CONSUMER_ENABLED=true OUTBOX_PUBLISHER_ENABLED=true PENDING_REFERENCE_WORKER_ENABLED=true
PORT=3001 bun run start   # terminal 1
PORT=3002 bun run start   # terminal 2
PORT=3003 bun run start   # terminal 3
```

As métricas são por instância: cada `/metrics` mostra só o que aquela instância fez.

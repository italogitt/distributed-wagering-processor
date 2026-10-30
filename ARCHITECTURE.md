# ARCHITECTURE.md

## 1. Visão geral

Este serviço é uma carteira (wallet) de cassino online. Ele recebe apostas de provedores de jogos por dois caminhos: HTTP e fila SQS. Os dois caminhos chamam o mesmo caso de uso. Cada operação atualiza o saldo, grava no ledger (livro-razão: o histórico de cada movimentação de saldo) e registra um evento para publicar depois. Tudo isso vai para o PostgreSQL na mesma transação SQL. Um publisher envia os eventos ao SQS, e um worker resolve as reversões que chegaram antes da transação referenciada.

## 2. Organização do código

Usei camadas no estilo hexagonal (o núcleo de regras não depende de framework; o resto se conecta a ele por interfaces).

| Pasta | Papel |
|---|---|
| `src/domain/` | Entidades e regras de negócio (`Wallet`, `Money`, `WagerTransaction`). Não importa Nest nem MikroORM. |
| `src/application/` | Casos de uso, serviços de aplicação e portas (interfaces que o caso de uso precisa, implementadas fora daqui). |
| `src/infrastructure/` | Implementações das portas: MikroORM (entidades do ORM, mappers, repositórios, migrations), SQS, logs e métricas. |
| `src/interfaces/` | Entradas do sistema: controllers HTTP, consumer SQS e workers (publisher da outbox e `PENDING_REFERENCE`). |

Não dividi o código por módulo de negócio (wallet, transaction etc.). Quase todo caso de uso grava wallet, transaction, ledger, inbox e outbox na mesma transação SQL, então separar por módulo só criaria dependências cruzadas.

## 3. Decisões

### Correção financeira

**D4 · D20 · D21 · `Money` em centavos (`bigint`)**
- **Decisão:** `Money` guarda centavos em `bigint`. A string com 2 casas exatas (`^\d+\.\d{2}$`) só existe nas bordas, e no banco a coluna é `numeric(20,2)`. Negativo só existe no meio de uma conta, nunca na entrada.
- **Por quê:** a escala é fixa em 2 casas, então todo valor é um inteiro de centavos, exato e sem dependência. Uma grafia única por valor deixa o `payloadHash` estável.
- **Custo:** a conversão string ↔ centavos é manual, e `"25"` ou `"25.5"` recebem 400 em vez de serem normalizados.
- **Provado por:** `test/domain/money.test.ts`

**D13 · Ledger imutável e saldo não negativo no schema**
- **Decisão:** triggers recusam `UPDATE`, `DELETE` e `TRUNCATE` em `ledger_entries`. CHECKs exigem `balance >= 0` na wallet, `balance_after = balance_before ± amount` e `amount > 0` no lançamento.
- **Por quê:** o enunciado pede as garantias no banco. Um bug ou um acesso direto não consegue apagar o histórico nem deixar saldo negativo.
- **Custo:** o trigger de `TRUNCATE` foi escrito à mão na migration (o `@Trigger` do MikroORM não cobre), e os testes não podem limpar o banco com `TRUNCATE` (D14).

**D26 · Reconciliação num único SELECT, sem correção**
- **Decisão:** `POST /wallets/:id/reconciliation` lê o saldo e soma créditos − débitos do ledger num único SELECT. Divergência gera log `warn`, métrica e `consistent: false`. Nada é corrigido.
- **Por quê:** em READ COMMITTED, um comando vê um snapshot só. Débito e lançamento commitam juntos, então uma BET concorrente aparece nos dois lados ou em nenhum.
- **Custo:** a consulta soma o ledger inteiro da wallet a cada chamada.
- **Provado por:** `test/integration/wallets.integration.ts` (inclui reconciliação em loop durante 100 BETs)

### Concorrência

**D10 · D22 · D24 · UPDATE condicional: o banco decide a corrida**
- **Decisão:** o débito é um único `UPDATE ... SET balance = balance - v, version = version + 1 WHERE id = ? AND balance >= v RETURNING *`. Com 1 linha, a `Wallet` é reidratada com o estado de antes e gera o lançamento. Com 0 linhas, a transação vira `REJECTED`. O repositório faz o UPDATE e o lançamento num método só (`applyDebit`/`applyCredit`).
- **Por quê:** o Postgres trava a linha, e a segunda operação reavalia o `WHERE` com o saldo já debitado. Funciona com várias instâncias e sem lock global.
- **Custo:** o fluxo é menos intuitivo (o UPDATE vem antes do método de domínio), e `version` é só um contador, não um lock otimista.
- **Provado por:** `test/integration/submit-transaction.integration.ts` (100 → 80/80 e 3 instâncias)

**D27 · FK do ledger para `transactions` DEFERRABLE**
- **Decisão:** a FK `ledger_entries.transaction_id` é `DEFERRABLE INITIALLY DEFERRED`.
- **Por quê:** o lançamento nasce no UPDATE condicional, antes do INSERT da transação, e o Postgres só confere a FK no COMMIT.
- **Custo:** um lançamento órfão só é barrado no COMMIT, não no INSERT.

**D28 · Releitura antes de gravar (READ COMMITTED)**
- **Decisão:** antes de responder, o caso de uso relê o que pode ter mudado: a linha da idempotency key e, quando não houve movimento, o saldo para o `balance_after`.
- **Por quê:** em READ COMMITTED cada SELECT vê um snapshot novo. Os testes acharam 2 bugs: (1) 50 envios iguais, a key não existia na 1ª leitura e o `externalTransactionId` já existia na 2ª → 409 falso; (2) um REFUND rejeitado como `ALREADY_REVERSED` respondia o saldo lido antes do crédito do ROLLBACK vencedor.
- **Custo:** mais uma leitura nesses caminhos.
- **Provado por:** `test/integration/submit-transaction.integration.ts` (testes 1 e 4)

### Idempotência

**D12 · D29 · `UNIQUE (provider_id, idempotency_key)` + `payloadHash`**
- **Decisão:** a key é única por provedor no banco. Mesma key e mesmo hash devolve o resultado original (`idempotentReplay: true`), com o `balance_after` gravado na transação. Mesma key com hash diferente devolve 409 `IDEMPOTENCY_CONFLICT`.
- **Por quê:** a deduplicação fica no banco, vale para todas as instâncias e sobrevive a reinício. O hash é SHA-256 de um JSON com chaves ordenadas, só com campos de negócio.
- **Custo:** o `balance_after` é uma coluna a mais, necessária porque `LOSS` e `REJECTED` não têm linha no ledger.
- **Provado por:** `test/integration/submit-transaction.integration.ts`, `test/application/submit-transaction.use-case.test.ts`

**D30 · Um retry só, depois de `UniqueViolation`**
- **Decisão:** se o INSERT bate num índice único, a transação SQL faz rollback (inclusive do débito) e o caso de uso roda de novo uma vez. Na 2ª vez ele acha a linha vencedora e devolve replay, 409 ou `ALREADY_REVERSED`.
- **Por quê:** é o que segura "a mesma aposta 50 vezes em paralelo" com um débito só, sem lock pessimista.
- **Custo:** se violar de novo, sobe 500. Não há loop.
- **Provado por:** `test/integration/submit-transaction.integration.ts` (teste 1), `test/integration/sqs-consumer.integration.ts` (teste 7)

**D15 · D16 · Inbox por `(consumer, messageId de negócio)`**
- **Decisão:** `inbox_messages` tem `UNIQUE (consumer, message_id)`, gravada na mesma transação SQL do processamento. O `message_id` é o id do corpo da mensagem, não o `MessageId` do SQS.
- **Por quê:** um reenvio do provedor ganha outro `MessageId` no SQS, mas mantém o id de negócio. Se a linha existe, a mensagem já foi processada, então não preciso de `processedAt` nem de `payloadHash` na inbox.
- **Custo:** a inbox sozinha não detecta o mesmo id com payload diferente. Quem pega é a idempotência da `transactions` (D29).
- **Provado por:** `test/integration/sqs-consumer.integration.ts` (testes 2 e 3)

### Mensageria e falhas

**D17 · D18 · D19 · Outbox na mesma transação + publisher com `SKIP LOCKED`**
- **Decisão:** os eventos vão para `outbox_events` no mesmo commit do negócio. O publisher trava um lote com `FOR UPDATE SKIP LOCKED`, pega no máximo um evento por aggregate (o mais antigo pela coluna `sequence`) e publica no SQS FIFO com `MessageGroupId = aggregateId` e `MessageDeduplicationId = eventId`. Falha → backoff `min(2^tentativas, 60 s)`, sem limite de tentativas.
- **Por quê:** nenhum evento sai antes do commit nem se perde depois dele. Vários publishers não pegam o mesmo evento, e a ordem por aggregate se mantém.
- **Custo:** se o processo cair entre o envio e o commit, o evento sai de novo, com o mesmo `eventId`. Quem consome precisa ser idempotente.
- **Provado por:** `test/integration/outbox-publisher.integration.ts`, `test/integration/restart.integration.ts`

**D31 · Consumer: ack depois do commit e três tipos de erro**
- **Decisão:** o `DeleteMessage` só roda depois do commit. Erro de negócio (404/409/422) → ack. Transitório → sem ack e visibilidade `min(2^recebimentos, 60 s)`; depois de 5 recebimentos o redrive do SQS manda para a DLQ. Permanente (JSON inválido, `type` desconhecido, payload inválido) → cópia na DLQ e ack. No SIGTERM, espera as mensagens em andamento até o prazo e devolve as outras com visibilidade 0.
- **Por quê:** o enunciado pede essa classificação. Morrer depois do commit e antes do ack só gera uma redelivery, que a inbox barra.
- **Custo:** um retry segura as mensagens seguintes do mesmo grupo FIFO (elas voltam para a fila sem processar).
- **Provado por:** `test/integration/sqs-consumer.integration.ts`

**D32 · `PENDING_REFERENCE` com worker, backoff e TTL**
- **Decisão:** REFUND/ROLLBACK/WIN cuja referência não existe é gravada como `PENDING_REFERENCE` (HTTP 202). O worker trava uma por vez (`FOR UPDATE SKIP LOCKED`), tenta de novo com backoff `min(2^tentativas, 60 s)` e, depois de 10 min do `created_at`, rejeita com `REFERENCE_NOT_FOUND` e publica `WagerTransactionRejected`.
- **Por quê:** com backoff de até 60 s, 10 min dão ~15 tentativas. Uma referência que não chega nesse tempo dificilmente é atraso de entrega, e o provedor precisa de uma resposta final.
- **Custo:** a reversão fica sem decisão por até 10 min.
- **Provado por:** `test/integration/pending-reference.integration.ts`

### Modelagem

**D3 · D11 · Domínio separado do ORM, uma transação por `fork()`**
- **Decisão:** cada conceito tem duas classes, ex.: `Wallet` (domínio, construtor privado + `create`/`rehydrate`) e `WalletRecord` (MikroORM 7.2.5), ligadas por um mapper. Cada `UnitOfWork.run` abre um `EntityManager` novo e uma transação SQL em READ COMMITTED.
- **Por quê:** o enunciado pede domínio sem ORM e reidratação sem revalidar. Duas requisições nunca compartilham estado; a concorrência fica com o UPDATE condicional e os índices únicos.
- **Custo:** mappers para manter, e saldo e ledger passam por SQL explícito, não pelo change tracking do ORM.

**D33 · Máquina de estados da transação**
- **Decisão:** `PENDING` → `PROCESSED` | `REJECTED` | `PENDING_REFERENCE` | `FAILED`; `PENDING_REFERENCE` → `PROCESSED` | `REJECTED` | `FAILED`. Os três finais não mudam mais. CHECKs do banco espelham as regras (ex.: `processed_at` só em `PROCESSED`).
- **Por quê:** transição inválida vira erro de domínio, e o banco barra um estado impossível vindo de um bug.
- **Custo:** a regra existe em dois lugares (domínio e CHECKs).
- **Provado por:** `test/domain/wager-transaction.test.ts`

**D34 · `TransactionSettlement` compartilhado**
- **Decisão:** referência, reversão ativa, movimento de saldo, `balance_after` e eventos ficam num serviço usado pelo caso de uso (INSERT) e pelo worker (UPDATE).
- **Por quê:** uma reversão resolvida pelo worker segue exatamente as regras da entrada.
- **Custo:** gravar a linha e a outbox fica com quem chama, porque é o que muda entre os dois.
- **Provado por:** `test/application/resolve-pending-reference.use-case.test.ts`

### Testes

**D14 · Banco por execução**
- **Decisão:** cada `test:integration` cria `wallet_test_<aleatório>` e o apaga no fim. Cada arquivo recria o schema e roda as migrations.
- **Por quê:** duas execuções ao mesmo tempo não derrubam o schema uma da outra, e o `TRUNCATE` é recusado pelo trigger do ledger (D13).
- **Custo:** recriar o schema por arquivo deixa a suíte mais lenta (~50 s).

**D35 · Invariante saldo == ledger**
- **Decisão:** um `afterEach` confere `wallet.balance == soma do ledger` para todas as wallets do banco.
- **Por quê:** é o invariante final pedido pelo enunciado.
- **Custo:** roda em 6 dos 8 arquivos de integração (`health` e `metrics` não movem saldo).

### Observabilidade

**D36 · Logs JSON sem valores financeiros**
- **Decisão:** uma linha JSON por evento, com `correlationId`, `messageId` (SQS), `transactionId`, `walletId` e `providerId`. Nunca o payload, nunca valores. Nos erros de entrada, só o nome do erro (a mensagem pode citar o valor).
- **Por quê:** a seção 12 proíbe payload financeiro no log. A mensagem completa de uma mensagem enviada à DLQ (que pode citar o valor) fica só no atributo `failureReason` da cópia na DLQ.
- **Custo:** para ver valores é preciso consultar a API ou o banco.
- **Provado por:** `test/integration/sqs-consumer.integration.ts` (teste 5)

**D37 · Métricas Prometheus em `GET /metrics`**
- **Decisão:** `transactions_total{status,kind,source}`, `duplicates_total{type}`, `retries_total{component}`, `dlq_messages_total{reason}`, `concurrency_conflicts_total{type}` (`unique_violation` e `conditional_debit_rejected`), `outbox_pending_events`, `outbox_lag_seconds`, `transaction_processing_seconds{source}` e `reconciliation_mismatches_total`. Health em `/health/live` e `/health/ready` (Postgres + SQS).
- **Por quê:** cobre a lista da seção 12. Sem lock pessimista, os conflitos que existem são o retry após `UniqueViolation` e o débito recusado pelo UPDATE condicional.
- **Custo:** os gauges da outbox fazem uma consulta a cada scrape.
- **Provado por:** `test/integration/metrics.integration.ts`, `test/infrastructure/metrics/metrics.test.ts`

## 4. Erros e status HTTP

| Status | Quando | Corpo |
|---|---|---|
| 200 | Transação decidida: `PROCESSED`, ou `REJECTED` por regra de negócio (com `failureCode`). Também consultas e reconciliação. | Resultado |
| 201 | Wallet criada. | Wallet |
| 202 | Aceita, aguardando referência (`PENDING_REFERENCE`). | Resultado sem saldo |
| 400 | Payload inválido, `Idempotency-Key` ausente, `limit` ou `cursor` inválidos. | `INVALID_INPUT` |
| 404 | Wallet ou transação inexistente (id fora do formato também). | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND` |
| 409 | Mesma key com outro payload, ou `externalTransactionId` com outra key; wallet duplicada. | `IDEMPOTENCY_CONFLICT`, `WALLET_ALREADY_EXISTS` |
| 422 | Wallet de outro player ou de outra moeda. | `WALLET_MISMATCH` |
| 503 | Falha transitória de infraestrutura (banco fora do ar, timeout, deadlock). Nada foi gravado. | `SERVICE_UNAVAILABLE` |
| 500 | Bug. | Padrão do Nest |

Nada é gravado em 400, 404, 409 e 422. `/health/ready` responde 503 quando o Postgres ou o SQS não respondem.

## 5. Códigos de falha

Vêm no campo `failureCode` de uma transação `REJECTED` (HTTP 200). Reenviar a mesma key devolve o mesmo resultado (replay). Para tentar de novo, é preciso uma transação nova (outro `externalTransactionId` e outra key).

| Código | Quando | O que o provedor faz |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET sem saldo. | Desistir. |
| `REVERSAL_INSUFFICIENT_FUNDS` | ROLLBACK que deixaria o saldo negativo (ex.: reverter um WIN já gasto). Fica auditável. | Desistir; tratar fora do fluxo automático. |
| `REFERENCE_NOT_FOUND` | A referência não chegou em 10 min. | Corrigir: enviar a referência e mandar a reversão de novo como transação nova. |
| `INVALID_REFERENCE` | A referência é de outro provider, player, wallet, moeda ou rodada, de `kind` incompatível ou não está `PROCESSED`. | Corrigir o payload. |
| `ALREADY_REVERSED` | A referência já tem um REFUND ou ROLLBACK ativo. | Desistir: o efeito já aconteceu. |
| `AMOUNT_MISMATCH` | Valor da reversão diferente do valor da referência. | Corrigir o valor. |

Erros sem `failureCode` (seção 4): 400, 404, 409 e 422 → corrigir; 503 → reenviar com a mesma key, com backoff; 500 → reenviar com a mesma key.

## 6. Autenticação

Não implementei. A seção 2 do enunciado aceita isso, e autenticação não vale pontos.

Desenho que eu adotaria: Keycloak como Identity Provider, com um client por provedor de jogos (client credentials). O provedor pede um token ao Keycloak e manda no header `Authorization`. O `AuthGuard` valida o token (assinatura, expiração, audience) e confere se o `providerId` do token é igual ao `providerId` do corpo.

Ponto de extensão: `src/interfaces/http/auth.guard.ts`, um `AuthGuard` no-op aplicado aos controllers de wallet e de wagering. Health e metrics ficam abertos. A fila é canal interno confiável, mas a identidade do provedor na mensagem passa pelas mesmas validações de domínio.

## 7. Interpretações do enunciado

| # | Dúvida | Interpretação |
|---|---|---|
| I1 | `referenceTransactionId` e `processedAt` em `transactions`. | Existem: `reference_transaction_id` (id interno da referência resolvida) e `processed_at`, ambos com CHECK. |
| I2 | Replay devolve o saldo da época, mas `LOSS` e `REJECTED` não têm ledger. | `balance_after` em `transactions` (D29). |
| I3 | `InboxMessage` com `payloadHash`/`processedAt` e classes `InboxMessage`/`OutboxMessage`. | Inbox e outbox são tabelas tratadas pelos repositórios, sem classe de domínio. A inbox não tem esses campos (D15). |
| I5 | WIN pode referenciar outra transação? | Pode, só uma BET. Quando vem, a referência é validada como nas reversões. |
| I6 | Quantas reversões por transação? | Uma no total, somando REFUND e ROLLBACK (índice `transactions_single_reversal_uq`). Sem isso, os dois creditariam duas vezes. |
| I7 | Valor do `LOSS`. | Sempre `0.00` (CHECK no banco). |
| I8 | Wallet inexistente, ou de outro player/moeda. | 404 e 422, sem gravar nada. |
| I9 | `FAILED` ("erro permanente de infraestrutura"). | Existe no domínio e no schema, mas nenhum fluxo usa hoje. Falha transitória não grava nada e é refeita. |
| I10 | "Escala fixa de 2 casas". | Só a grafia exata com 2 casas é aceita (D21). |
| I11 | O esqueleto sugere `Decimal`. | `bigint` em centavos, permitido pela seção 6 (D4). |
| I12 | Saldo inicial e `version` na criação. | A wallet nasce com o saldo e `version = 1`. Saldo > 0 gera `OPENING` + `CREDIT` + `WalletBalanceChanged` na mesma transação; saldo 0, só a wallet. |
| D5 | Quem gera os ids? | A aplicação, em UUIDv7 (ordenável por data), como nos exemplos do enunciado. |

## 8. Limitações conhecidas

- **LocalStack fixo em 4.14.0:** as versões novas exigem token de licença.
- **Retry segura o grupo FIFO:** enquanto uma mensagem espera o backoff, as seguintes da mesma wallet também esperam (D31).
- **Um evento por aggregate por ciclo do publisher:** uma wallet com muitos eventos pendentes leva um ciclo por evento (D19).
- **Transação SQL aberta durante o envio ao SQS:** o lote fica travado enquanto o SQS responde (D19).
- **Poison-pill no worker:** uma `PENDING_REFERENCE` que lança erro em todo ciclo volta sempre primeiro e trava a fila do worker.
- **DLQ do redrive fora da métrica:** `dlq_messages_total` só conta o que o consumer manda. O redrive do SQS após 5 recebimentos não passa pela app.
- **`conditional_debit_rejected` não distingue corrida:** uma BET sem saldo, sem ninguém concorrendo, também conta.
- **Métricas por instância:** cada `/metrics` mostra só a sua instância. Agregar é papel do Prometheus.
- **Brecha do keyset:** o `created_at` do ledger vem do relógio da app. Uma transação que pegou o horário antes e commitou depois de uma página já lida fica fora da paginação.
- **Erros de negócio do SQS (404/409/422) sem linha na inbox:** o rollback desfaz a inbox. Uma redelivery reprocessa e chega à mesma decisão, sem efeito.
- **Sem teste de carga e sem autenticação** (seção 6).
- **Listas só no domínio:** o CHECK de moeda confere só o formato `^[A-Z]{3}$` (D7), e `failure_code` é texto livre (o CHECK só exige que exista em `REJECTED`/`FAILED`). Quem grava sem passar pelo `Money` sofre o arredondamento silencioso do Postgres (`1.005` vira `1.01`).
- **`player_id` sem FK:** não há tabela de players; esse dado é de outro sistema.
- **Brechas no schema:** os triggers do ledger não barram `DROP TABLE` (em produção, a app usaria um usuário sem DDL), e sem FK composta o banco não garante que a wallet e a moeda do lançamento são as da transação.
- **Sem ordem entre aggregates:** `WalletBalanceChanged` (wallet) e `WagerTransactionProcessed` (transação) ficam em grupos FIFO diferentes.
- **Migrations sem `CASCADE` no `down`:** um `down` pode falhar e pedir ajuste manual.

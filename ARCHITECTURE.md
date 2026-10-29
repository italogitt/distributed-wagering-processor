# ARCHITECTURE.md

## 1. Visão geral

Este serviço é uma carteira (wallet) de cassino online. Ele recebe apostas de provedores de jogos por dois caminhos: HTTP e fila SQS. Os dois caminhos chamam o mesmo caso de uso. Cada operação atualiza o saldo, grava no ledger (livro-razão: o histórico de cada movimentação de saldo) e registra um evento para publicar depois. Tudo isso vai para o PostgreSQL na mesma transação SQL.

## 2. Organização do código

Usei camadas no estilo hexagonal (o núcleo de regras não depende de framework; o resto se conecta a ele por interfaces).

| Pasta | Papel |
|---|---|
| `src/domain/` | Entidades e regras de negócio (`Wallet`, `Money` etc.). Não importa Nest nem MikroORM. |
| `src/application/` | Casos de uso e portas (interfaces que o caso de uso precisa, como repositórios, implementadas fora daqui). |
| `src/infrastructure/` | Implementações das portas: MikroORM (entidades do ORM, mappers, repositórios, migrations) e SQS. |
| `src/interfaces/` | Entradas do sistema: controllers HTTP e consumer SQS. Os dois chamam o mesmo caso de uso. |

Não dividi o código por módulo de negócio (wallet, transaction etc.). Quase todo caso de uso grava wallet, transaction, ledger, inbox e outbox na mesma transação SQL, então separar por módulo só criaria dependências cruzadas.

## 3. Decisões

## Stack

### D1. Versões fixadas da stack
- **Decisão:** fixei MikroORM 7.2.5, NestJS 12.1.3 e TypeScript 5.9.
- **Por quê:** o TypeScript 7 é o port do compilador para Go. Com o prazo curto, evitei o risco de algo quebrar com decorators, que o Nest e o MikroORM usam muito.
- **Trade-off:** `TODO: o que eu perco ficando no 5.9?`
- **Alternativa descartada:** TypeScript 7.

### D11. MikroORM como ORM
- **Decisão:** usei o MikroORM.
- **Por quê:** é o ORM da stack usada na empresa. Não escolhi por um motivo de arquitetura.
- **Trade-off:** `TODO: algum custo que eu percebi usando o MikroORM?`

## Arquitetura do código

### D2. Camadas no estilo hexagonal, sem divisão por módulo
- **Decisão:** separei o código em `domain/`, `application/`, `infrastructure/` e `interfaces/` (ver seção 2). HTTP e SQS chamam o mesmo caso de uso.
- **Por quê:** o enunciado pede domínio sem ORM. Também não dividi por módulo porque quase todo caso de uso grava wallet, transaction, ledger, inbox e outbox na mesma transação SQL.
- **Trade-off:** `TODO: custo dessa organização (ex.: mais arquivos, mais indireção?)`
- **Alternativa descartada:** divisão por módulo de negócio.

### D3. Entidade de domínio separada da entidade do ORM
- **Decisão:** cada conceito tem duas classes. Por exemplo, `Wallet` (domínio) e `WalletRecord` (MikroORM). O repositório converte uma na outra com um mapper.
- **Por quê:** o enunciado pede construtor privado + `rehydrate` (método que reconstrói a entidade a partir de dados já salvos) e domínio sem ORM. Uma entidade do ORM não atende isso.
- **Trade-off:** preciso escrever e manter os mappers. Também não uso o change tracking do ORM (quando o ORM detecta sozinho o que mudou e gera o UPDATE).

## Dinheiro

### D4. `Money` em centavos (`bigint`) por dentro, string com 2 casas nas bordas, `numeric(20,2)` no banco
- **Decisão:** o value object `Money` guarda o valor como `bigint` em centavos (`"25.00"` → `2500n`). A string decimal com 2 casas só existe nas bordas: na entrada (`from`), na saída (`toJSON`/`toString`) e no banco, onde a coluna é `numeric(20,2)`.
- **Por quê:** o enunciado fixa a escala em 2 casas para toda moeda, então todo valor é um número inteiro de centavos. O `bigint` é nativo do JavaScript, exato, e não traz dependência para o domínio. O MikroORM v7 devolve `decimal` como string, que é o mesmo formato das bordas.
- **Trade-off:** preciso converter string ↔ centavos na mão no `from` e no `toJSON`. E `JSON.stringify` quebra com `bigint`, então o valor nunca pode sair do `Money` sem passar pelo `toJSON`.
- **Alternativa descartada:** `Decimal`, que o esqueleto sugere. A seção 6 do enunciado permite adaptar, desde que as garantias se mantenham (ver I11).
- **Exemplo:** `0.1 + 0.2` em `number` dá `0.30000000000000004`. Em centavos, `10n + 20n = 30n` → `"0.30"`.

### D20. `Money`: sinal, zero e moedas diferentes
- **Decisão:** `Money.from()` rejeita valor negativo, mas `subtract` e `negate` podem gerar negativo. Zero é válido (`Money.zero`). Entre moedas diferentes, `add`, `subtract` e `isLessThan` lançam erro de domínio, enquanto `equals` devolve `false`. A regra "> 0, ou = 0 para `LOSS`" fica na `WagerTransaction`, não no `Money`.
- **Por quê:** o enunciado proíbe negativos "em contratos de entrada", mas o próprio esqueleto tem `negate()` e `isNegative()` (ver I9). O `from()` é a porta das strings externas (API, fila, banco), e nenhuma delas é negativa: o saldo é sempre ≥ 0, e o lançamento do ledger guarda valor positivo com uma direção. Já o negativo no meio de uma conta é útil, porque é com ele que a `Wallet` detecta saldo insuficiente. O `equals` é uma pergunta, e "10 BRL ≠ 10 USD" é uma resposta válida, não um erro.
- **Trade-off:** fica uma assimetria. `negate()` gera `"-10.00"` no `toJSON`, e o `from()` não aceita essa string de volta. Na prática isso nunca acontece, porque nenhum negativo é persistido nem recebido.
- **Exemplo:** saldo 20, `BET` de 30 → `subtract` dá −10 → a `Wallet` vê `isNegative()` e decide "saldo insuficiente". O `Money` só fez a conta.

### D21. `Money`: formato de entrada estrito
- **Decisão:** o `from()` aceita só `^\d+\.\d{2}$`, sem zeros à esquerda (`"025.00"` é rejeitado; `"0.50"` é aceito). `"25"`, `"25.5"`, `"1.005"`, `"1e3"`, `"NaN"`, `"Infinity"`, `""` e negativos são rejeitados.
- **Por quê:** o enunciado mostra `"25.00"` e exige "escala fixa de 2 casas" (ver I10). Com uma única grafia por valor, o `payloadHash` (hash do corpo da requisição, usado para detectar reenvio com conteúdo diferente) fica estável. Além disso, o Postgres arredonda `numeric` em silêncio (`1.005` vira `1.01`), então só o domínio consegue barrar casas a mais.
- **Trade-off:** um provedor que mande `"25"` recebe 4xx em vez de ter o valor normalizado.
- **Exemplo:** se a entrada fosse tolerante, `"25.5"` e `"25.50"` poderiam gerar hashes diferentes, e o reenvio da mesma aposta viraria conflito de idempotência.

## Banco de dados e schema

### D5. id da wallet gerado na aplicação (UUIDv7)
- **Decisão:** a aplicação gera o id da wallet como UUIDv7 (UUID que começa com um timestamp, então fica ordenável por data de criação). O `DEFAULT gen_random_uuid()` do banco fica só como reserva.
- **Por quê:** os exemplos do enunciado usam UUIDv7.
- **Trade-off:** `TODO: custo dessa escolha.`

### D6. `player_id` sem foreign key
- **Decisão:** `player_id` não tem FK.
- **Por quê:** não existe tabela de players. Quem é dono desse dado é outro sistema.
- **Trade-off:** o banco não garante que o player existe.

### D7. CHECK de moeda valida só o formato
- **Decisão:** o CHECK (regra validada pelo próprio banco) de moeda só confere o formato `^[A-Z]{3}$`. A lista de moedas aceitas fica no domínio.
- **Por quê:** `TODO: por que a lista fica no domínio e não no banco?`
- **Trade-off:** o banco aceitaria `XYZ`. Só o domínio barra moedas inválidas.

### D8. Constraints com nome explícito
- **Decisão:** dei nome explícito a todas as constraints.
- **Por quê:** assim consigo mapear erros do Postgres (`23505` = violação de unique, `23514` = violação de CHECK) para códigos de erro da API, olhando qual constraint falhou.
- **Trade-off:** `TODO: custo dessa escolha.`

### D9. Migrations geradas pelo ORM e revisadas à mão
- **Decisão:** o MikroORM gera as migrations e eu reviso cada uma. Os `down` não usam `CASCADE` (opção que apaga junto tudo que depende do objeto, como FKs).
- **Por quê:** prefiro que um `down` falhe a apagar FKs em silêncio.
- **Trade-off:** um `down` pode falhar e exigir ajuste manual.

### D13. Ledger imutável no próprio schema
- **Decisão:** triggers (funções que o banco roda sozinho quando um comando acontece) recusam `UPDATE`, `DELETE` e `TRUNCATE` na tabela do ledger. Os de `UPDATE` e `DELETE` ficam declarados no `@Trigger` do MikroORM. O de `TRUNCATE` escrevi à mão na migration, por uma limitação do MikroORM.
- **Por quê:** `TODO: por que garantir a imutabilidade no banco, e não só na aplicação?`
- **Trade-off:** o trigger de `TRUNCATE` fica fora do `@Trigger`, então o ORM não sabe dele e eu mantenho esse trecho à mão. Ele também não barra `DROP TABLE` (ver Limitações).

## Concorrência

### D10. UPDATE condicional no banco; `wallet.version` é só um contador
- **Decisão:** o débito/crédito é um único UPDATE atômico condicional: `SET balance = balance - valor, version = version + 1 ... WHERE balance >= valor`. O `wallet.version` só sobe quando o saldo muda e não é o optimistic lock do ORM. `updated_at` também só muda junto com o saldo.
- **Por quê:** a regra do débito (subtrair se houver saldo) cabe inteira num UPDATE. Então deixei o banco fazer a conta e a checagem juntos. O Postgres trava a linha durante o UPDATE, e a segunda operação na mesma wallet espera a primeira terminar. Isso funciona com várias instâncias da aplicação, porque a trava fica no banco e não na memória de cada instância.
- **Trade-off:** o `version` não detecta concorrência, só conta as mudanças de saldo.
- **Alternativa descartada:** optimistic lock (trava otimista: ler o saldo e a versão, calcular na aplicação e gravar com `WHERE version = <versão lida>`), sozinho ou junto com o UPDATE condicional. Ele precisa de mais idas ao banco (SELECT + UPDATE) e de retry quando há conflito. E ele recusa sempre que algo mudou desde a leitura, mesmo com saldo sobrando, o que gera conflitos falsos.
- **Exemplo:** saldo 100, duas apostas de 80 ao mesmo tempo → a primeira deixa o saldo em 20, a segunda não encontra `balance >= 80` → só uma passa. Já com duas apostas de 10: no UPDATE condicional as duas passam (saldo 80). Com optimistic lock, a segunda falharia por conflito de versão, mesmo havendo saldo.

### D22. O banco decide a corrida; a `Wallet` é reidratada com o estado de antes
- **Decisão:** o UPDATE condicional da D10 roda primeiro, com `WHERE id = :id AND balance >= :valor RETURNING balance, version`. Se ele afeta uma linha, reidrato a `Wallet` com o estado de antes do UPDATE: saldo devolvido + valor, `version` devolvida − 1. Em seguida, `wallet.debit(...)` aplica a operação em memória, valida o resultado e gera o lançamento. Se o UPDATE afeta 0 linhas, o saldo é insuficiente e a transação vira `REJECTED`.
- **Por quê:** a `Wallet` carregada no início da requisição pode estar desatualizada. No cenário obrigatório, duas instâncias carregam saldo 100 e as duas acham que podem debitar 80. Só o banco vê o saldo real na hora da escrita. Depois do UPDATE, a linha fica travada pela transação SQL até o commit, então o "antes" calculado é exato e o lançamento do ledger sempre bate com o banco.
- **Trade-off:** o fluxo é menos intuitivo, porque o UPDATE vem antes do método de domínio. E a checagem de saldo do domínio vira uma segunda trava, que na prática só dispara se houver bug.
- **Exemplo:** saldo 100, duas `BET`s de 80 ao mesmo tempo. O UPDATE da primeira devolve 20 → reidrato com saldo 100 / version 1 → `debit(80)` → lançamento 100 → 20, version 2. O UPDATE da segunda testa `WHERE 20 >= 80` → 0 linhas → `REJECTED`, sem lançamento.

## Wallet: regras do agregado

Agregado: um grupo de objetos que muda junto e tem uma entidade principal. Aqui, a `Wallet` e os seus lançamentos do ledger.

### D23. `debit` e `credit` devolvem o lançamento
- **Decisão:** `debit` e `credit` devolvem um `WalletLedgerEntry`. O `debit` lança erro de domínio se o saldo ficaria negativo, e os dois lançam erro se a moeda não for a da wallet. A `version` sobe +1 a cada chamada.
- **Por quê:** a regra "toda alteração de saldo tem lançamento" passa a ser estrutural: não há como mudar o saldo sem criar o lançamento. O erro do `debit` não é caminho de negócio. Como o banco já barrou o saldo insuficiente (D22), chegar nele indica bug.
- **Trade-off:** a `Wallet` passa a conhecer o `WalletLedgerEntry`. Acho aceitável, porque ele faz parte do agregado. E isso garante que o lançamento seja criado, mas não que seja salvo. A D24 resolve essa parte.

### D24. Um método só no repositório para debitar e creditar
- **Decisão:** a porta do repositório expõe `applyDebit(walletId, money, transactionId)` e `applyCredit(...)`. Cada um executa junto, na mesma transação SQL: o UPDATE condicional, a reidratação, `wallet.debit`/`credit` e a gravação do lançamento. O resultado é o lançamento ou "saldo insuficiente". Não existe método separado para só atualizar o saldo.
- **Por quê:** com os passos soltos no caso de uso, alguém poderia rodar o UPDATE e esquecer o lançamento, e o TypeScript não avisa quando um retorno é ignorado. Com um método só, a regra "toda alteração de saldo tem lançamento" vale em todo caminho que passa pelo repositório.
- **Trade-off:** o repositório fica mais "esperto" que um simples buscar/salvar, porque passa a conter parte da orquestração.

### D25. Abertura da wallet com saldo inicial
- **Decisão:** `Wallet.open({ id, playerId, initialBalance, openingTransactionId, at })` cria a wallet já com o saldo inicial e `version = 1`. Se `initialBalance > 0`, devolve também o lançamento `CREDIT` (antes 0, depois o saldo inicial), ligado à transação `OPENING`. Com saldo zero, não há transação nem lançamento.
- **Por quê:** o enunciado diz que a `version` começa em 1 depois da criação (ver I12). Abrir com 0 e chamar `credit` daria `version = 2`.
- **Trade-off:** o `open` não reaproveita o `credit` e tem uma regra própria para a `version`.
- **Exemplo:** `open` com 50.00 BRL → wallet com saldo 50.00, version 1, e um lançamento `CREDIT` 0.00 → 50.00.

## Idempotência

### D12. `balance_after` em `transactions` para o replay
- **Decisão:** cada transação guarda `balance_after`, o saldo observado quando ela foi processada. No replay (reenvio de uma requisição já processada), devolvo esse valor.
- **Por quê:** o replay deve devolver o saldo da época, não o atual. `LOSS` e `REJECTED` não geram linha no ledger, então não dá para tirar esse saldo de lá.
- **Trade-off:** `TODO: custo dessa escolha.`

## Mensageria (inbox/outbox/SQS)

### D15. Inbox sem `payloadHash` e sem `processedAt`
- **Decisão:** a `inbox_messages` (tabela que registra as mensagens do SQS já recebidas, para não processar a mesma duas vezes) não tem `payloadHash` nem `processedAt`. É um desvio consciente do enunciado.
- **Por quê:** a linha da inbox é gravada no mesmo commit do processamento. Então, se a linha existe, a mensagem já foi processada; não preciso de `processedAt` para saber isso. A comparação de payload fica na idempotência da `transactions`, que é igual para HTTP e SQS.
- **Trade-off:** a inbox sozinha não detecta uma mensagem com o mesmo id e payload diferente. Quem pega isso é a idempotência da `transactions`. `TODO: outro custo?`

### D16. `message_id` da inbox é o id de negócio da mensagem
- **Decisão:** o `message_id` da inbox é o id de negócio que vem no corpo da mensagem, não o `MessageId` que o SQS gera.
- **Por quê:** quando o provedor reenvia a mesma mensagem, o SQS gera um `MessageId` novo. Com ele, a deduplicação não funcionaria.
- **Trade-off:** `TODO: custo dessa escolha.`
- **Alternativa descartada:** usar o `MessageId` do SQS.

### D17. `next_attempt_at` na outbox para backoff
- **Decisão:** a `outbox_events` (tabela onde gravo os eventos na mesma transação do negócio, para publicar no SQS depois) tem `next_attempt_at`. Quando a publicação falha, o evento só é tentado de novo a partir desse horário.
- **Por quê:** para fazer backoff (esperar um tempo antes de tentar de novo, em vez de repetir na hora).
- **Trade-off:** `TODO: custo dessa escolha.`
- `TODO: intervalos do backoff e limite de tentativas.`

### D18. Ordem FIFO por aggregate na outbox
- **Decisão:** os eventos saem em ordem FIFO (primeiro a entrar, primeiro a sair) por aggregate (a entidade dona do evento, como uma wallet ou uma transação). Um evento só é publicado quando não existe outro mais antigo pendente do mesmo aggregate. A coluna `sequence` define a ordem.
- **Por quê:** `TODO: por que a ordem por aggregate importa?` Usei `sequence` e não `created_at` porque `created_at` empata entre eventos gravados na mesma transação.
- **Trade-off:** um evento que fica falhando segura todos os seguintes daquele aggregate.

### D19. Vários publishers com `FOR UPDATE SKIP LOCKED`
- **Decisão:** posso rodar vários publishers (processos que leem a outbox e publicam no SQS) ao mesmo tempo. Eles buscam eventos com `FOR UPDATE SKIP LOCKED`: cada publisher trava as linhas que pegou, e os outros pulam essas linhas em vez de esperar.
- **Por quê:** assim cada evento é pego por um publisher só.
- **Trade-off:** duplicação ainda pode acontecer. Se o processo morrer depois de publicar e antes de marcar `published_at`, o evento é publicado de novo. Trato isso com o `MessageDeduplicationId` do SQS (igual ao id do evento) e com a idempotência de quem consome.

## Erros e status HTTP

_A preencher._

## Observabilidade

_A preencher._

## Autenticação

_A preencher._

## Testes

### D14. Reset do banco recriando o schema
- **Decisão:** entre os testes, reseto o banco recriando o schema, não com `TRUNCATE`.
- **Por quê:** o trigger da D13 recusa `TRUNCATE` no ledger, então não dá para limpar o banco com `TRUNCATE`.
- **Trade-off:** `TODO: custo dessa escolha.`

## 4. Interpretações do enunciado

| # | Trecho / dúvida | Minha interpretação | Status |
|---|---|---|---|
| I1 | `transactions` no enunciado tem `referenceTransactionId` (id interno) e `processedAt`, que a minha modelagem não tem. | `TODO` | Em aberto |
| I2 | O replay deve devolver o saldo da época. Mas `LOSS` e `REJECTED` não geram ledger, então não dá para tirar esse saldo do ledger. | Guardo `balance_after` em `transactions` (D12). | Decidido |
| I3 | `inbox_messages` no enunciado tem `payloadHash` e `processedAt`. | Não uso nenhum dos dois. Desvio consciente (D15). | Decidido |
| I4 | `outbox_events` no enunciado tem `nextAttemptAt`. | Uso `next_attempt_at` para o backoff (D17). | Decidido |
| I5 | O `WIN` pode trazer uma referência a outra transação? | Pode. Quando vem, valido a referência do mesmo jeito que nas reversões (`REFUND` e `ROLLBACK`, operações que desfazem outra transação). | Decidido |
| I6 | Quantas vezes uma transação pode ser revertida? | Uma vez no total, somando `REFUND` e `ROLLBACK`. É mais restrito que o enunciado. Sem isso, um `REFUND` mais um `ROLLBACK` da mesma aposta creditariam o valor duas vezes. | Decidido |
| I7 | Valor do `LOSS`. | Sempre `0`. | Decidido |
| I8 | Requisição para wallet inexistente, ou com player ou moeda diferentes dos da wallet. | Devolvo 4xx e não gravo nada. `TODO: qual status exato?` | Decidido |
| I9 | O enunciado proíbe negativos "em contratos de entrada", mas o esqueleto do `Money` tem `negate()` e `isNegative()`. | Negativo é proibido só na entrada (`from()`). Dentro das contas ele pode existir (D20). | Decidido |
| I10 | "Escala fixa de 2 casas", com exemplos como `"25.00"`. | Aceito só a grafia exata com 2 casas. `"25"` e `"25.5"` são rejeitados, não normalizados (D21). | Decidido |
| I11 | O esqueleto sugere `Decimal` para o `Money`. | Uso `bigint` em centavos. A seção 6 permite adaptar, desde que as garantias se mantenham (D4). | Decidido |
| I12 | A `version` começa em 1 depois da criação. E se a wallet abrir com saldo inicial? | O crédito de abertura não conta como mudança de versão: a wallet nasce com o saldo e `version = 1` (D25). | Decidido |

## 5. Limitações conhecidas

- O CHECK de moeda aceita qualquer código de 3 letras maiúsculas (ex.: `XYZ`). Só o domínio barra moedas que não existem (D7).
- Quem grava no banco sem passar pelo `Money` sofre o arredondamento silencioso do Postgres (D21).
- `negate()` gera `"-10.00"` no `toJSON`, mas o `from()` não aceita essa string de volta. Hoje nenhum negativo é persistido nem recebido, então isso não acontece na prática (D20).
- Um provedor que mande `"25"` ou `"25.5"` recebe 4xx. Não normalizo o valor (D21).
- O banco não garante que o `player_id` existe (D6).
- Os `down` das migrations podem falhar e pedir ajuste manual (D9).
- Requisições recusadas por wallet inexistente, player ou moeda diferentes não ficam gravadas. Então não existe registro de idempotência para elas, e um reenvio é validado de novo do zero (I8).
- `failure_code` é texto livre no banco. A lista de códigos válidos fica só no domínio, então o banco aceitaria qualquer texto.
- Os triggers do ledger não barram `DROP TABLE`. Quem tem permissão de DDL (comandos que mudam a estrutura do banco, como `CREATE`, `ALTER` e `DROP`) ainda consegue apagar o ledger. Num ambiente real, a aplicação usaria um usuário do banco sem permissão de DDL (D13).
- O banco não garante que a wallet e a moeda de um lançamento do ledger são as mesmas da transação. O `UNIQUE (wallet_id, transaction_id)` não impede que um bug crie um lançamento numa wallet diferente da transação. Uma FK composta (FK sobre mais de uma coluna ao mesmo tempo) resolveria, mas não implementei.
- A ordem FIFO da outbox é por `aggregate_id`. Eventos da wallet (`aggregate_type = 'wallet'`) e da transação (`'transaction'`) ficam em grupos diferentes. Então não há ordem garantida entre `WalletBalanceChanged` e `WagerTransactionProcessed` (D18).

## 6. Pendências

- `TODO:` D1, trade-off de ficar no TypeScript 5.9.
- `TODO:` D2, trade-off da organização em camadas.
- `TODO:` D5, trade-off de gerar o UUIDv7 na aplicação.
- `TODO:` D7, por que a lista de moedas fica no domínio e não no banco.
- `TODO:` D8, trade-off das constraints com nome explícito.
- `TODO:` D11, trade-off de usar o MikroORM.
- `TODO:` D12, trade-off do `balance_after`.
- `TODO:` D13, por que garantir a imutabilidade do ledger no banco.
- `TODO:` D14, trade-off de resetar o banco recriando o schema.
- `TODO:` D15, outro custo de tirar `payloadHash` e `processedAt` da inbox.
- `TODO:` D16, trade-off de usar o id de negócio como `message_id`.
- `TODO:` D17, trade-off, intervalos do backoff e limite de tentativas da outbox.
- `TODO:` D18, por que a ordem por aggregate importa.
- `TODO:` I8, status HTTP exato para wallet inexistente e para player/moeda diferentes.
- `TODO:` taxonomia de `failureCode`.
- `TODO:` D20, ajustar o exemplo "a `Wallet` decide saldo insuficiente" à D22/D23, em que quem decide é o banco?
- `TODO:` confirmar se a tabela `wallets` tem `CHECK (balance >= 0)` como segunda proteção contra saldo negativo.
- Em aberto: I1, `referenceTransactionId` e `processedAt` em `transactions`.

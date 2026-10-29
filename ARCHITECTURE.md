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

### D4. `numeric(20,2)` no banco, string no TypeScript e na API
- **Decisão:** valores ficam em `numeric(20,2)` no Postgres e trafegam como string no código e na API. O value object `Money` rejeita valores com mais de 2 casas decimais.
- **Por quê:** o MikroORM v7 já devolve `decimal` como string. E o Postgres arredonda em silêncio: `1.005` vira `1.01`. Por isso a validação tem que estar no `Money`, antes de chegar no banco.
- **Trade-off:** o banco sozinho não protege contra casas a mais. Quem grava sem passar pelo `Money` fica sujeito ao arredondamento silencioso.

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

## Idempotência

### D12. `balance_after` em `transactions` para o replay
- **Decisão:** cada transação guarda `balance_after`, o saldo observado quando ela foi processada. No replay (reenvio de uma requisição já processada), devolvo esse valor.
- **Por quê:** o replay deve devolver o saldo da época, não o atual. `LOSS` e `REJECTED` não geram linha no ledger, então não dá para tirar esse saldo de lá.
- **Trade-off:** `TODO: custo dessa escolha.`

## Mensageria (inbox/outbox/SQS)

_A preencher._

## Erros e status HTTP

_A preencher._

## Observabilidade

_A preencher._

## Autenticação

_A preencher._

## Testes

### D14. Reset do banco recriando o schema
- **Decisão:** entre os testes, reseto o banco recriando o schema, não com `TRUNCATE`.
- **Por quê:** `TODO: motivo (é porque o trigger da D13 recusa TRUNCATE no ledger?)`
- **Trade-off:** `TODO: custo dessa escolha.`

## 4. Interpretações do enunciado

| # | Trecho / dúvida | Minha interpretação | Status |
|---|---|---|---|
| I1 | `transactions` no enunciado tem `referenceTransactionId` (id interno) e `processedAt`, que a minha modelagem não tem. | `TODO` | Em aberto |
| I2 | O replay deve devolver o saldo da época. Mas `LOSS` e `REJECTED` não geram ledger, então não dá para tirar esse saldo do ledger. | Guardo `balance_after` em `transactions` (D12). | Decidido |
| I3 | `inbox_messages` no enunciado tem `payloadHash` e `processedAt`. | `TODO` | Em aberto |
| I4 | `outbox_events` no enunciado tem `nextAttemptAt`. | `TODO` | Em aberto |
| I5 | O `WIN` pode trazer uma referência a outra transação? | Pode. Quando vem, valido a referência do mesmo jeito que nas reversões (`REFUND` e `ROLLBACK`, operações que desfazem outra transação). | Decidido |
| I6 | Quantas vezes uma transação pode ser revertida? | Uma vez no total, somando `REFUND` e `ROLLBACK`. É mais restrito que o enunciado. Sem isso, um `REFUND` mais um `ROLLBACK` da mesma aposta creditariam o valor duas vezes. | Decidido |
| I7 | Valor do `LOSS`. | Sempre `0`. | Decidido |
| I8 | Requisição para wallet inexistente, ou com player ou moeda diferentes dos da wallet. | Devolvo 4xx e não gravo nada. `TODO: qual status exato?` | Decidido |

## 5. Limitações conhecidas

- O CHECK de moeda aceita qualquer código de 3 letras maiúsculas (ex.: `XYZ`). Só o domínio barra moedas que não existem (D7).
- Quem grava no banco sem passar pelo `Money` sofre o arredondamento silencioso do Postgres (D4).
- O banco não garante que o `player_id` existe (D6).
- Os `down` das migrations podem falhar e pedir ajuste manual (D9).
- Requisições recusadas por wallet inexistente, player ou moeda diferentes não ficam gravadas. Então não existe registro de idempotência para elas, e um reenvio é validado de novo do zero (I8).
- `failure_code` é texto livre no banco. A lista de códigos válidos fica só no domínio, então o banco aceitaria qualquer texto.
- Os triggers do ledger não barram `DROP TABLE`. Quem tem permissão de DDL (comandos que mudam a estrutura do banco, como `CREATE`, `ALTER` e `DROP`) ainda consegue apagar o ledger. Num ambiente real, a aplicação usaria um usuário do banco sem permissão de DDL (D13).
- O banco não garante que a wallet e a moeda de um lançamento do ledger são as mesmas da transação. O `UNIQUE (wallet_id, transaction_id)` não impede que um bug crie um lançamento numa wallet diferente da transação. Uma FK composta (FK sobre mais de uma coluna ao mesmo tempo) resolveria, mas não usei. `TODO: qual decisão justifica não usar FK composta?`

## 6. Pendências

- `TODO:` D1, trade-off de ficar no TypeScript 5.9.
- `TODO:` D2, trade-off da organização em camadas.
- `TODO:` D5, trade-off de gerar o UUIDv7 na aplicação.
- `TODO:` D7, por que a lista de moedas fica no domínio e não no banco.
- `TODO:` D8, trade-off das constraints com nome explícito.
- `TODO:` D11, trade-off de usar o MikroORM.
- `TODO:` D12, trade-off do `balance_after`.
- `TODO:` D13, por que garantir a imutabilidade do ledger no banco.
- `TODO:` D14, motivo e trade-off de resetar o banco recriando o schema.
- `TODO:` limitação do ledger, qual decisão justifica não usar FK composta.
- `TODO:` I8, status HTTP exato para wallet inexistente e para player/moeda diferentes.
- `TODO:` taxonomia de `failureCode`.
- `TODO:` confirmar se a tabela `wallets` tem `CHECK (balance >= 0)` como segunda proteção contra saldo negativo.
- Em aberto: I1, `referenceTransactionId` e `processedAt` em `transactions`.
- Em aberto: I3, `payloadHash` e `processedAt` em `inbox_messages`.
- Em aberto: I4, `nextAttemptAt` em `outbox_events`.

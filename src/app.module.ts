import { EntityManager } from '@mikro-orm/postgresql';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { SubmitTransactionUseCase } from './application/use-cases/submit-transaction.use-case';
import mikroOrmConfig from './infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work';
import { UuidV7IdGenerator } from './infrastructure/uuid-v7-id-generator';
import { ApplicationErrorFilter } from './interfaces/http/application-error.filter';
import { WageringController } from './interfaces/http/wagering.controller';

@Module({
  imports: [
    // Sem request context: o UnitOfWork faz `fork()` a cada transação.
    MikroOrmModule.forRoot({ ...mikroOrmConfig, registerRequestContext: false }),
  ],
  controllers: [WageringController],
  providers: [
    { provide: APP_FILTER, useClass: ApplicationErrorFilter },
    {
      // O caso de uso não conhece o Nest: a montagem fica aqui.
      provide: SubmitTransactionUseCase,
      inject: [EntityManager],
      useFactory: (em: EntityManager) => new SubmitTransactionUseCase(new MikroOrmUnitOfWork(em), new UuidV7IdGenerator()),
    },
  ],
})
export class AppModule {}

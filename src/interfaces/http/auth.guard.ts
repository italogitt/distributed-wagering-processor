import { type CanActivate, Injectable } from '@nestjs/common';

/**
 * Ponto de extensão da autenticação (seção 2): hoje deixa tudo passar.
 * O que faltaria para produção está no ARCHITECTURE.md (seção de autenticação).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

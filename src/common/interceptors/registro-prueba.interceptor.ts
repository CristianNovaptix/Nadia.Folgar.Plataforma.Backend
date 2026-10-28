import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { AuthenticatedUser } from '../types/authenticated-user';
import { esUsuarioPrueba, registroPruebaContext } from '../database/registro-prueba';

/** Corre el handler dentro del contexto que usa `registroPruebaPlugin` para marcar lo creado. */
@Injectable()
export class RegistroPruebaInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const user = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>()?.user;
    const store = { esPrueba: esUsuarioPrueba(user) };
    return new Observable((subscriber) =>
      registroPruebaContext.run(store, () => next.handle().subscribe(subscriber)),
    );
  }
}

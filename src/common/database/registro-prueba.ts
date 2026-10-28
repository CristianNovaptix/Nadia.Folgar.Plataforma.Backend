import { AsyncLocalStorage } from 'node:async_hooks';
import { Model, Schema } from 'mongoose';

/**
 * Cuentas cuyos registros quedan marcados como de prueba (`esPrueba: true`),
 * para distinguirlos de los datos reales del estudio. Hoy solo la cuenta de
 * admin de desarrollo/pruebas ("Yami"): se reconoce por su id y por sus
 * emails (el de login y el institucional), por si alguno cambia.
 */
export const IDS_USUARIOS_PRUEBA = ['6a847bcc4663561cccd91efa'];
export const EMAILS_USUARIOS_PRUEBA = ['alimayneleb@gmail.com', 'admin@folgar.com.ar'];

export const esUsuarioPrueba = (user?: { userId?: string; email?: string | null }): boolean =>
  Boolean(user) &&
  ((!!user!.userId && IDS_USUARIOS_PRUEBA.includes(user!.userId)) ||
    (!!user!.email && EMAILS_USUARIOS_PRUEBA.includes(user!.email.trim().toLowerCase())));

/** Modelos que nunca se marcan como de prueba (pedido del usuario: las reglas de clasificación se usan con datos reales). */
export const MODELOS_SIN_MARCA_PRUEBA = ['ReglaClasificacion'];

/** Contexto del request en curso — lo abre `RegistroPruebaInterceptor`. */
export const registroPruebaContext = new AsyncLocalStorage<{ esPrueba: boolean }>();

/**
 * Plugin global: suma `esPrueba` a todos los schemas y lo marca en `true` al
 * crear un documento dentro de un request de un usuario de prueba.
 */
export function registroPruebaPlugin(schema: Schema): void {
  schema.add({ esPrueba: { type: Boolean } });

  schema.pre('save', function () {
    if (this.$isSubdocument || !this.isNew) return;
    if (MODELOS_SIN_MARCA_PRUEBA.includes((this.constructor as Model<unknown>).modelName)) return;
    if (registroPruebaContext.getStore()?.esPrueba) this.set('esPrueba', true);
  });

  schema.pre('insertMany', function (this: Model<unknown>, next: () => void, docs: unknown) {
    if (MODELOS_SIN_MARCA_PRUEBA.includes(this.modelName)) return next();
    if (registroPruebaContext.getStore()?.esPrueba && Array.isArray(docs)) {
      for (const doc of docs as Record<string, unknown>[]) doc.esPrueba = true;
    }
    next();
  });
}

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { baseSchemaOptions } from '../../common/database/base-schema.options';
import { ProveedorIA } from '../../common/enums/proveedor-ia.enum';

export type ClienteDocument = HydratedDocument<Cliente>;

export enum RegimenFiscal {
  RESPONSABLE_INSCRIPTO = 'responsable_inscripto',
  MONOTRIBUTO = 'monotributo',
  EXENTO = 'exento',
}

/**
 * Credencial de acceso a un organismo fiscal (ARCA/ARBA/AGIP) para un
 * cliente — pedido explícito del usuario, pantalla "Credenciales" de
 * `ClienteFormDialog`. Mismo criterio de cifrado que `IntegracionIa.apiKeyCifrada`
 * (Configuración → Integraciones): `passwordCifrada` nunca sale de
 * `ClientesService` en claro, `passwordPreview` (ej. "····kuY0") es lo único
 * que se manda al Frontend — ver `ClientesService.sanitizeCredenciales`.
 */
@Schema({ _id: false })
export class CredencialOrganismo {
  @Prop({ trim: true })
  usuario?: string;

  @Prop()
  passwordCifrada?: string;

  @Prop()
  passwordPreview?: string;
}

export const CredencialOrganismoSchema = SchemaFactory.createForClass(CredencialOrganismo);

@Schema(baseSchemaOptions)
export class Cliente {
  @Prop({ required: true, trim: true })
  nombre: string;

  @Prop({ required: true, unique: true })
  cuit: string;

  @Prop({ trim: true })
  contacto?: string;

  @Prop({ type: String, enum: RegimenFiscal })
  regimenFiscal?: RegimenFiscal;

  @Prop({ trim: true, lowercase: true })
  email?: string;

  @Prop()
  telefono?: string;

  @Prop({ trim: true })
  responsable?: string;

  /**
   * Miembros de "Personal" (equipo interno, `users/`) asignados como
   * responsables de este cliente — a diferencia de `responsable` (texto
   * libre, arriba), esto es una referencia real: quien tenga su ID en este
   * array ve este cliente en su fila de la pantalla Personal del Frontend, y
   * comparte el tablero de tareas de este cliente. Puede ser más de uno
   * (pedido explícito del usuario: un cliente puede tener varios integrantes
   * a cargo a la vez, ej. Daiana + Nadia Folgar) — antes (`responsableId`,
   * campo simple) solo admitía uno; ver la migración de datos real corrida a
   * mano contra la base (`responsableId` → `responsableIds: [valor]`,
   * documentada en el CLAUDE.md). Aparte y sin relación con este array, `GET
   * /clientes` agrega `responsablesEfectivos` (no persistido, ver
   * `ClientesService.attachResponsablesEfectivos`): SOLO quien tenga
   * `User.esTitular` (hoy únicamente Nadia Folgar) — pedido explícito del
   * usuario: "Responsable" (el dueño real del estudio) y "Personal a cargo"
   * (este array) son dos conceptos separados que NO se mezclan, aunque la
   * misma persona pueda estar en los dos a la vez (ver el caso de
   * Salischiker Raquel en el CLAUDE.md). A propósito NO es "cualquier
   * admin": hay una cuenta de admin de desarrollo/pruebas que no debe
   * aparecer ahí, ver el comentario en `user.schema.ts`.
   */
  @Prop({ type: [Types.ObjectId], ref: 'User', default: [] })
  responsableIds: Types.ObjectId[];

  /**
   * "Responsable" real, elegible por cliente — pedido explícito del
   * usuario: reemplaza el criterio anterior (`responsablesEfectivos`, SOLO
   * calculado por `User.esTitular`, igual para todos los clientes, sin
   * poder elegir otra persona). Ahora es un único miembro de "Personal"
   * (distinto de `responsableIds`/"Personal a cargo", que admite varios) —
   * `undefined` = todavía no se eligió a mano, y `ClientesService` lo
   * completa con el/la titular del estudio como default al armar la
   * respuesta (`responsableTitular`, ver `attachResponsablesEfectivos`),
   * sin persistir nada hasta que se guarde explícitamente esa elección
   * (aunque sea la default, sin tocar nada).
   */
  @Prop({ type: Types.ObjectId, ref: 'User' })
  responsableTitularId?: Types.ObjectId;

  @Prop({ default: true })
  activo: boolean;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Estudio', required: true, index: true })
  estudioId: Types.ObjectId;

  /**
   * Override del motor de IA que usan los procesos con IA de este cliente
   * (hoy: extractos-ia) — vacío = usa `Estudio.motorIaPorDefecto`. Solo se
   * puede setear a un proveedor que el estudio ya tenga conectado en
   * Configuración → Integraciones (`ClientesService` lo valida al guardar).
   */
  @Prop({ type: String, enum: ProveedorIA })
  motorIaPreferido?: ProveedorIA;

  /** Credenciales de acceso a cada organismo fiscal — ver `CredencialOrganismo` arriba. */
  @Prop({ type: CredencialOrganismoSchema })
  credencialesArca?: CredencialOrganismo;

  @Prop({ type: CredencialOrganismoSchema })
  credencialesArba?: CredencialOrganismo;

  @Prop({ type: CredencialOrganismoSchema })
  credencialesAgip?: CredencialOrganismo;
}

export const ClienteSchema = SchemaFactory.createForClass(Cliente);
ClienteSchema.index({ estudioId: 1, nombre: 1 });

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { baseSchemaOptions } from '../../common/database/base-schema.options';

export type GoogleCalendarCuentaDocument = HydratedDocument<GoogleCalendarCuenta>;

/**
 * Cuenta de Google Calendar que conectó un usuario ("Sincronizar cuenta" en la
 * Agenda del estudio). Una por usuario: cada uno sincroniza la suya. Vive aparte
 * de `User` para que el refresh token (cifrado) nunca viaje en las respuestas de `/users`.
 */
@Schema(baseSchemaOptions)
export class GoogleCalendarCuenta {
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true, unique: true })
  userId: Types.ObjectId;

  /** Email de la cuenta de Google conectada (solo para mostrarlo). */
  @Prop({ required: true, trim: true })
  email: string;

  /** Refresh token de Google, cifrado con `SecretCipherService`. */
  @Prop({ required: true })
  refreshTokenCifrado: string;

  /** `nextSyncToken` de Google: desde dónde leer los cambios hechos en su calendario. */
  @Prop()
  syncToken?: string;
}

export const GoogleCalendarCuentaSchema = SchemaFactory.createForClass(GoogleCalendarCuenta);

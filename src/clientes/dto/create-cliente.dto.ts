import {
  IsArray,
  IsEmail,
  IsEnum,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { RegimenFiscal } from '../schemas/cliente.schema';
import { ProveedorIA } from '../../common/enums/proveedor-ia.enum';
import { CredencialOrganismoDto } from './credencial-organismo.dto';

export class CreateClienteDto {
  @IsString()
  @MinLength(2)
  nombre: string;

  @Matches(/^\d{2}-?\d{8}-?\d{1}$/, {
    message: 'cuit debe tener formato válido (ej. 20-12345678-9)',
  })
  cuit: string;

  @IsOptional()
  @IsString()
  contacto?: string;

  @IsOptional()
  @IsEnum(RegimenFiscal)
  regimenFiscal?: RegimenFiscal;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  telefono?: string;

  @IsOptional()
  @IsString()
  responsable?: string;

  /**
   * IDs de usuarios de "Personal" (`users/`) — ver `responsableIds` en
   * `cliente.schema.ts`. Puede ser más de uno; ausente/`[]` = sin nadie
   * asignado manualmente (igual puede aparecer un admin en
   * `responsablesEfectivos`, ver el service).
   */
  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  responsableIds?: string[];

  /**
   * "Responsable" elegido a mano para este cliente — ver
   * `responsableTitularId` en `cliente.schema.ts`. Ausente = no tocar el ya
   * guardado (mismo criterio que `responsableIds`); el Frontend siempre
   * manda un valor concreto una vez que el diálogo termina de cargar (el
   * default es el/la titular del estudio), así que en la práctica esto
   * pasa a estar seteado la primera vez que alguien guarda ese cliente.
   */
  @IsOptional()
  @IsMongoId()
  responsableTitularId?: string;

  /** Override del motor de IA para este cliente — debe estar conectado en Configuración → Integraciones (validado en `ClientesService`). */
  @IsOptional()
  @IsEnum(ProveedorIA)
  motorIaPreferido?: ProveedorIA;

  /** Credenciales de acceso a cada organismo fiscal — ver `CredencialOrganismoDto`. */
  @IsOptional()
  @ValidateNested()
  @Type(() => CredencialOrganismoDto)
  credencialesArca?: CredencialOrganismoDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => CredencialOrganismoDto)
  credencialesArba?: CredencialOrganismoDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => CredencialOrganismoDto)
  credencialesAgip?: CredencialOrganismoDto;
}

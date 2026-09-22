import { PartialType, OmitType } from '@nestjs/swagger';
import { ArrayUnique, IsArray, IsBoolean, IsIn, IsOptional } from 'class-validator';
import { PERMISSIONS, PermissionCode } from '../../common/constants/permissions';
import { CreateUserDto } from './create-user.dto';

const ALL_PERMISSIONS = Object.values(PERMISSIONS) as PermissionCode[];

export class UpdateUserDto extends PartialType(OmitType(CreateUserDto, ['password'] as const)) {
  @IsOptional()
  @IsBoolean()
  activo?: boolean;

  /** Excepciones de permisos del usuario — ver el comentario en `user.schema.ts`. */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(ALL_PERMISSIONS, { each: true })
  permisosExtra?: PermissionCode[];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(ALL_PERMISSIONS, { each: true })
  permisosDenegados?: PermissionCode[];
}

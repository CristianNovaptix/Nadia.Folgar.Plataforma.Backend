import { IsMongoId, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class QueryCarpetaDocumentoDto {
  /** Ignorado para el rol 'cliente': siempre ve solo las suyas. */
  @IsOptional()
  @IsMongoId()
  clienteId?: string;
}

export class CreateCarpetaDocumentoDto {
  @IsMongoId()
  clienteId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  nombre: string;

  /** Sin valor (o null) = en la raíz de la documentación del cliente. */
  @IsOptional()
  @IsMongoId()
  carpetaPadreId?: string | null;
}

export class UpdateCarpetaDocumentoDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  nombre?: string;

  /** null = mover a la raíz. */
  @IsOptional()
  @IsMongoId()
  carpetaPadreId?: string | null;
}

/** Mover un documento a otra carpeta (null = raíz). */
export class MoverDocumentoDto {
  @IsOptional()
  @IsMongoId()
  carpetaId?: string | null;
}

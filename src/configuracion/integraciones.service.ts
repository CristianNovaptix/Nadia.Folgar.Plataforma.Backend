import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { IntegracionIa, IntegracionIaDocument } from './schemas/integracion-ia.schema';
import { Estudio, EstudioDocument } from '../tenancy/schemas/estudio.schema';
import { ProveedorIA } from '../common/enums/proveedor-ia.enum';
import { ConectarIntegracionDto } from './dto/conectar-integracion.dto';
import { SecretCipherService } from '../common/crypto/secret-cipher.service';
import { ProveedorIaValidatorService } from './proveedor-ia-validator.service';

/** Forma que sale hacia el Frontend — nunca la key completa, solo el preview. */
export interface IntegracionMasked {
  proveedor: ProveedorIA;
  apiKeyPreview: string;
  modelo?: string;
  conectadoPor: Types.ObjectId;
  updatedAt: Date;
}

/** Credencial descifrada, de uso interno — solo la consume `AiProviderResolverService`, nunca sale de este módulo. */
export interface CredencialDescifrada {
  apiKey: string;
  modelo?: string;
}

/**
 * Conectar/desconectar proveedores de IA y elegir el motor por defecto del
 * estudio (Configuración → Integraciones). No hay OAuth real disponible para
 * OpenAI/Anthropic (verificado antes de construir esto) — el usuario pega la
 * key generada a mano en el panel del proveedor, y acá se valida contra el
 * proveedor real (`ProveedorIaValidatorService`) antes de cifrarla y
 * guardarla, para que el flujo sea confiable pese a no ser un clic único.
 */
@Injectable()
export class IntegracionesService {
  constructor(
    @InjectModel(IntegracionIa.name)
    private readonly integracionModel: Model<IntegracionIaDocument>,
    @InjectModel(Estudio.name) private readonly estudioModel: Model<EstudioDocument>,
    private readonly secretCipher: SecretCipherService,
    private readonly validator: ProveedorIaValidatorService,
  ) {}

  async listar(
    estudioId: Types.ObjectId,
  ): Promise<{ integraciones: IntegracionMasked[]; motorIaPorDefecto?: ProveedorIA }> {
    const [integraciones, estudio] = await Promise.all([
      this.integracionModel.find({ estudioId }).exec(),
      this.estudioModel.findById(estudioId).exec(),
    ]);
    return {
      integraciones: integraciones.map((doc) => this.toMasked(doc)),
      motorIaPorDefecto: estudio?.motorIaPorDefecto,
    };
  }

  /** Valida la key contra el proveedor real antes de cifrarla y guardarla. Conectar de nuevo el mismo proveedor reemplaza la key anterior. */
  async conectar(
    estudioId: Types.ObjectId,
    userId: Types.ObjectId,
    dto: ConectarIntegracionDto,
  ): Promise<IntegracionMasked> {
    await this.validator.validar(dto.proveedor, dto.apiKey);

    const integracion = await this.integracionModel
      .findOneAndUpdate(
        { estudioId, proveedor: dto.proveedor },
        {
          apiKeyCifrada: this.secretCipher.encrypt(dto.apiKey),
          apiKeyPreview: `····${dto.apiKey.slice(-4)}`,
          modelo: dto.modelo,
          conectadoPor: userId,
          estudioId,
          proveedor: dto.proveedor,
        },
        { upsert: true, new: true },
      )
      .exec();

    return this.toMasked(integracion);
  }

  async desconectar(estudioId: Types.ObjectId, proveedor: ProveedorIA): Promise<void> {
    await this.integracionModel.deleteOne({ estudioId, proveedor }).exec();
  }

  /** Rechaza si el proveedor elegido no tiene una integración conectada — no tiene sentido elegir como default algo que no funciona. */
  async setMotorPorDefecto(
    estudioId: Types.ObjectId,
    proveedor: ProveedorIA,
  ): Promise<EstudioDocument> {
    const conectada = await this.integracionModel.findOne({ estudioId, proveedor }).exec();
    if (!conectada) {
      throw new BadRequestException(
        'Conectá esa integración en Configuración → Integraciones antes de elegirla como motor por defecto',
      );
    }

    const estudio = await this.estudioModel
      .findByIdAndUpdate(estudioId, { motorIaPorDefecto: proveedor }, { new: true })
      .exec();
    if (!estudio) {
      throw new NotFoundException('Estudio no encontrado');
    }
    return estudio;
  }

  async obtenerConfigNotificaciones(
    estudioId: Types.ObjectId,
  ): Promise<{ anticipacionAvisoTareasHoras: number }> {
    const estudio = await this.estudioModel.findById(estudioId).exec();
    return { anticipacionAvisoTareasHoras: estudio?.anticipacionAvisoTareasHoras ?? 48 };
  }

  async actualizarConfigNotificaciones(
    estudioId: Types.ObjectId,
    anticipacionAvisoTareasHoras: number,
  ): Promise<{ anticipacionAvisoTareasHoras: number }> {
    const estudio = await this.estudioModel
      .findByIdAndUpdate(estudioId, { anticipacionAvisoTareasHoras }, { new: true })
      .exec();
    if (!estudio) {
      throw new NotFoundException('Estudio no encontrado');
    }
    return { anticipacionAvisoTareasHoras: estudio.anticipacionAvisoTareasHoras };
  }

  /** Uso interno de `AiProviderResolverService` — nunca se expone vía controller. */
  async obtenerCredencialDescifrada(
    estudioId: Types.ObjectId,
    proveedor: ProveedorIA,
  ): Promise<CredencialDescifrada | null> {
    const integracion = await this.integracionModel.findOne({ estudioId, proveedor }).exec();
    if (!integracion) {
      return null;
    }
    return {
      apiKey: this.secretCipher.decrypt(integracion.apiKeyCifrada),
      modelo: integracion.modelo,
    };
  }

  private toMasked(doc: IntegracionIaDocument): IntegracionMasked {
    return {
      proveedor: doc.proveedor,
      apiKeyPreview: doc.apiKeyPreview,
      modelo: doc.modelo,
      conectadoPor: doc.conectadoPor,
      updatedAt: (doc as unknown as { updatedAt: Date }).updatedAt,
    };
  }
}

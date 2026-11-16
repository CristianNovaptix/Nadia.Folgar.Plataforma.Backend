import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Role, RoleDocument } from './schemas/role.schema';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISOS_AGREGADOS_DESPUES,
} from '../common/constants/permissions';

@Injectable()
export class RolesService implements OnModuleInit {
  constructor(@InjectModel(Role.name) private readonly roleModel: Model<RoleDocument>) {}

  /**
   * Siembra los 3 roles de sistema si no existen todavía. A los que ya
   * existían les agrega, una sola vez, los permisos que se sumaron después
   * (`PERMISOS_AGREGADOS_DESPUES`).
   */
  async onModuleInit(): Promise<void> {
    for (const [nombre, permisos] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      const nuevos = permisos.filter((p) => PERMISOS_AGREGADOS_DESPUES.includes(p));
      const exists = await this.roleModel.findOne({ nombre }).exec();
      if (!exists) {
        await this.roleModel.create({
          nombre,
          permisos,
          esDeSistema: true,
          permisosSembrados: nuevos,
        });
        continue;
      }
      const faltantes = nuevos.filter((p) => !(exists.permisosSembrados ?? []).includes(p));
      if (faltantes.length > 0) {
        await this.roleModel
          .updateOne(
            { _id: exists._id },
            {
              $addToSet: {
                permisos: { $each: faltantes },
                permisosSembrados: { $each: faltantes },
              },
            },
          )
          .exec();
      }
    }
  }

  findAll(): Promise<RoleDocument[]> {
    return this.roleModel.find().sort({ nombre: 1 }).exec();
  }

  async findOne(id: string): Promise<RoleDocument> {
    const role = await this.roleModel.findById(id).exec();
    if (!role) {
      throw new NotFoundException('Rol no encontrado');
    }
    return role;
  }

  async findByNames(nombres: string[]): Promise<RoleDocument[]> {
    return this.roleModel.find({ nombre: { $in: nombres } }).exec();
  }

  create(dto: CreateRoleDto): Promise<RoleDocument> {
    return this.roleModel.create({ ...dto, esDeSistema: false });
  }

  async update(id: string, dto: UpdateRoleDto): Promise<RoleDocument> {
    const role = await this.findOne(id);
    if (role.esDeSistema && dto.nombre && dto.nombre !== role.nombre) {
      throw new BadRequestException('No se puede renombrar un rol de sistema');
    }
    Object.assign(role, dto);
    await role.save();
    return role;
  }

  async remove(id: string): Promise<void> {
    const role = await this.findOne(id);
    if (role.esDeSistema) {
      throw new BadRequestException('No se puede eliminar un rol de sistema');
    }
    await this.roleModel.deleteOne({ _id: id }).exec();
  }
}

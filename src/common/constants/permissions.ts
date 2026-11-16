export const PERMISSIONS = {
  USERS_READ: 'users.read',
  USERS_WRITE: 'users.write',
  ROLES_READ: 'roles.read',
  ROLES_WRITE: 'roles.write',
  CLIENTES_READ: 'clientes.read',
  CLIENTES_WRITE: 'clientes.write',
  EXTRACTOS_READ: 'extractos.read',
  EXTRACTOS_WRITE: 'extractos.write',
  EXTRACTOS_CUENTAS_READ: 'extractos.cuentas.read',
  EXTRACTOS_CUENTAS_WRITE: 'extractos.cuentas.write',
  EXTRACTOS_PLAN_CUENTAS_READ: 'extractos.plan-cuentas.read',
  EXTRACTOS_PLAN_CUENTAS_WRITE: 'extractos.plan-cuentas.write',
  EXTRACTOS_REGLAS_READ: 'extractos.reglas.read',
  EXTRACTOS_REGLAS_WRITE: 'extractos.reglas.write',
  PORTAL_DOCUMENTOS_READ: 'portal.documentos.read',
  PORTAL_DOCUMENTOS_WRITE: 'portal.documentos.write',
  NOTIFICACIONES_READ: 'notificaciones.read',
  NOTIFICACIONES_WRITE: 'notificaciones.write',
  ALERTAS_READ: 'alertas.read',
  ALERTAS_WRITE: 'alertas.write',
  IVA_TAREAS_READ: 'iva-tareas.read',
  IVA_TAREAS_WRITE: 'iva-tareas.write',
  FACTURACION_READ: 'facturacion.read',
  FACTURACION_WRITE: 'facturacion.write',
  FACTURACION_APROBAR: 'facturacion.aprobar',
  CATEDRAL_READ: 'catedral.read',
  CATEDRAL_WRITE: 'catedral.write',
  ASISTENTE_IA_USO: 'asistente-ia.uso',
  CONFIGURACION_READ: 'configuracion.read',
  CONFIGURACION_WRITE: 'configuracion.write',
  /** Finanzas completo: métricas y honorarios de todos los clientes. */
  FINANZAS_READ: 'finanzas.read',
  /** Cambiar abonos, generar deudas y anular pagos. */
  FINANZAS_WRITE: 'finanzas.write',
  /** Ver los honorarios de los clientes que tiene a cargo y registrarles pagos. */
  FINANZAS_COBROS: 'finanzas.cobros',
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** Roles fijos del estudio (admin/contador/cliente) mapeados a permisos por defecto. */
export const DEFAULT_ROLE_PERMISSIONS: Record<'admin' | 'contador' | 'cliente', PermissionCode[]> =
  {
    admin: Object.values(PERMISSIONS),
    contador: [
      PERMISSIONS.CLIENTES_READ,
      PERMISSIONS.CLIENTES_WRITE,
      PERMISSIONS.EXTRACTOS_READ,
      PERMISSIONS.EXTRACTOS_WRITE,
      PERMISSIONS.EXTRACTOS_CUENTAS_READ,
      PERMISSIONS.EXTRACTOS_CUENTAS_WRITE,
      PERMISSIONS.EXTRACTOS_PLAN_CUENTAS_READ,
      PERMISSIONS.EXTRACTOS_PLAN_CUENTAS_WRITE,
      PERMISSIONS.EXTRACTOS_REGLAS_READ,
      PERMISSIONS.EXTRACTOS_REGLAS_WRITE,
      PERMISSIONS.PORTAL_DOCUMENTOS_READ,
      PERMISSIONS.PORTAL_DOCUMENTOS_WRITE,
      PERMISSIONS.NOTIFICACIONES_READ,
      PERMISSIONS.NOTIFICACIONES_WRITE,
      PERMISSIONS.ALERTAS_READ,
      PERMISSIONS.IVA_TAREAS_READ,
      PERMISSIONS.IVA_TAREAS_WRITE,
      PERMISSIONS.FACTURACION_READ,
      PERMISSIONS.FACTURACION_WRITE,
      PERMISSIONS.CATEDRAL_READ,
      PERMISSIONS.CATEDRAL_WRITE,
      PERMISSIONS.ASISTENTE_IA_USO,
      PERMISSIONS.FINANZAS_COBROS,
    ],
    cliente: [PERMISSIONS.PORTAL_DOCUMENTOS_READ],
  };

/**
 * Permisos que se sumaron después de que los roles de sistema ya estaban
 * creados en la base. `RolesService` se los agrega una sola vez a cada rol
 * de sistema que los tenga por defecto; si después alguien se los quita
 * desde Seguridad, no vuelven a aparecer.
 */
export const PERMISOS_AGREGADOS_DESPUES: PermissionCode[] = [
  PERMISSIONS.FINANZAS_READ,
  PERMISSIONS.FINANZAS_WRITE,
  PERMISSIONS.FINANZAS_COBROS,
];

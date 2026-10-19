/**
 * Agrega `_id` como último criterio de orden. Sin un orden total, Mongo
 * devuelve los empates (ej. muchas reglas con la misma `prioridad`) en orden
 * distinto en cada consulta — con `skip/limit` eso repite registros entre
 * páginas y otros nunca llegan. Usar en todo listado paginado.
 */
export function conDesempatePorId(sort: Record<string, 1 | -1>): Record<string, 1 | -1> {
  if ('_id' in sort) return sort;
  const direcciones = Object.values(sort);
  return { ...sort, _id: direcciones[direcciones.length - 1] ?? 1 };
}

import { getServers, setServers } from 'node:dns';

const PUBLIC_DNS_SERVERS = ['1.1.1.1', '8.8.8.8'];

function isLoopback(server: string): boolean {
  return server.startsWith('127.') || server === '::1' || server.startsWith('[::1]');
}

/**
 * En Windows, algunas versiones de Node no logran leer los DNS del sistema y
 * el resolver (c-ares) queda apuntando solo a 127.0.0.1. Las consultas
 * comunes siguen andando porque van por el sistema operativo, pero las SRV
 * que necesita `mongodb+srv://` usan c-ares y fallan con
 * `querySrv ECONNREFUSED`, tirando abajo el arranque. Solo en ese caso
 * degenerado se pasa a resolvers públicos; un DNS real configurado no se toca.
 */
export function applyDnsFallback(): void {
  const servers = getServers();
  if (servers.length > 0 && !servers.every(isLoopback)) {
    return;
  }

  setServers(PUBLIC_DNS_SERVERS);
  console.warn(
    `[bootstrap] Node no detectó los DNS del sistema (${servers.join(', ') || 'ninguno'}); ` +
      `usando ${PUBLIC_DNS_SERVERS.join(', ')} para resolver MongoDB Atlas.`,
  );
}

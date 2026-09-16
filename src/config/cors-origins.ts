export function parseCorsOrigins(raw: string, nodeEnv: string): string[] | boolean {
  const origins = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (origins.length === 0) {
    return nodeEnv === 'development';
  }

  if (nodeEnv !== 'development') {
    return origins;
  }

  const viteLocalOrigins = Array.from({ length: 7 }, (_, index) => 5173 + index).flatMap((port) => [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ]);

  return Array.from(new Set([...origins, ...viteLocalOrigins]));
}

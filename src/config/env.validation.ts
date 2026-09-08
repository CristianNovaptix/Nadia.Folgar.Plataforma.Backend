import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  API_PREFIX: z.string().min(1).default('api/v1'),

  MONGODB_URI: z.string().min(1, 'MONGODB_URI es requerida'),
  REDIS_URL: z.string().optional(),
  QUEUE_MODE: z.enum(['inline', 'redis']).default('inline'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET debe tener al menos 16 caracteres'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET debe tener al menos 16 caracteres'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

  CORS_ORIGIN: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),

  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_CALLBACK_URL: z.string().url().optional(),
  LINKEDIN_OAUTH_CLIENT_ID: z.string().optional(),
  LINKEDIN_OAUTH_CLIENT_SECRET: z.string().optional(),
  LINKEDIN_OAUTH_CALLBACK_URL: z.string().url().optional(),
  APPLE_OAUTH_CLIENT_ID: z.string().optional(),
  APPLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  APPLE_OAUTH_TEAM_ID: z.string().optional(),
  APPLE_OAUTH_KEY_ID: z.string().optional(),
  APPLE_OAUTH_PRIVATE_KEY: z.string().optional(),
  APPLE_OAUTH_CALLBACK_URL: z.string().url().optional(),

  THROTTLE_TTL: z.coerce.number().int().positive().default(60000),
  THROTTLE_LIMIT: z.coerce.number().int().positive().default(300),

  /**
   * Selección del adapter de IA para extractos-ia (`AiExtractionPort`).
   * 'stub' (default) no requiere credenciales — así los tests y el desarrollo
   * local no dependen de una API key real. 'anthropic' usa Claude Sonnet 5,
   * 'openai' usa GPT-5.1.
   */
  AI_PROVIDER: z.enum(['stub', 'anthropic', 'openai']).default('stub'),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-5.1'),

  /**
   * Clave simétrica (32 bytes en base64) para `SecretCipherService` — cifra
   * las API keys de IA que el estudio conecta en Configuración →
   * Integraciones (`IntegracionIa.apiKeyCifrada`). Generar con
   * `openssl rand -base64 32` o `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
   */
  SECRETS_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, {
    message:
      'SECRETS_ENCRYPTION_KEY debe ser 32 bytes en base64 (ej. salida de `openssl rand -base64 32`)',
  }),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): EnvConfig {
  const result = envSchema
    .superRefine((data, ctx) => {
      if (data.AI_PROVIDER === 'anthropic' && !data.ANTHROPIC_API_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ANTHROPIC_API_KEY'],
          message: 'ANTHROPIC_API_KEY es requerida cuando AI_PROVIDER=anthropic',
        });
      }
      if (data.AI_PROVIDER === 'openai' && !data.OPENAI_API_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['OPENAI_API_KEY'],
          message: 'OPENAI_API_KEY es requerida cuando AI_PROVIDER=openai',
        });
      }
      if (data.QUEUE_MODE === 'redis' && !data.REDIS_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['REDIS_URL'],
          message: 'REDIS_URL es requerida cuando QUEUE_MODE=redis',
        });
      }
    })
    .safeParse(config);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuración de entorno inválida. Revisá tu .env:\n${issues}`);
  }

  return result.data;
}

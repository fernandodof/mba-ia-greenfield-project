import { registerAs } from '@nestjs/config';

// Fallbacks mirror the Joi defaults in env.validation.ts; the host is the
// Compose service name, never localhost.
export default registerAs('redis', () => ({
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  queuePrefix: process.env.QUEUE_PREFIX || 'bull',
}));

import type { ConfigModuleOptions } from '@nestjs/config';
import appConfig from './app.config';
import authConfig from './auth.config';
import databaseConfig from './database.config';
import { envValidationSchema } from './env.validation';
import mailConfig from './mail.config';
import redisConfig from './redis.config';
import storageConfig from './storage.config';
import swaggerConfig from './swagger.config';
import videoConfig from './video.config';

// Shared by the API (AppModule) and the video worker (VideoWorkerModule), so
// both processes load and validate the same configuration namespaces.
export const configModuleOptions: ConfigModuleOptions = {
  isGlobal: true,
  load: [
    appConfig,
    authConfig,
    databaseConfig,
    mailConfig,
    redisConfig,
    storageConfig,
    swaggerConfig,
    videoConfig,
  ],
  validationSchema: envValidationSchema,
  validationOptions: { allowUnknown: true, abortEarly: false },
};

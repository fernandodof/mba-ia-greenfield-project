import { Module } from '@nestjs/common';
import { StorageService } from './storage.service';

// StorageService reads `storageConfig` (endpoints, credentials, bucket),
// which AppModule loads into the global ConfigModule.
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}

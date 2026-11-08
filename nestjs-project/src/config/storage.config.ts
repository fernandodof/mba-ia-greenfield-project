import { registerAs } from '@nestjs/config';

// S3_ENDPOINT, S3_PUBLIC_ENDPOINT and the credentials are required by
// env.validation.ts, so they have no fallback here.
export default registerAs('storage', () => ({
  endpoint: process.env.S3_ENDPOINT!,
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT!,
  region: process.env.S3_REGION || 'us-east-1',
  accessKeyId: process.env.S3_ACCESS_KEY_ID!,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  bucket: process.env.S3_BUCKET || 'streamtube-videos',
}));

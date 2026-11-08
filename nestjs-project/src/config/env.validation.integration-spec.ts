import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ENDPOINT: 'http://minio:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY_ID: 'access-key',
  S3_SECRET_ACCESS_KEY: 'secret-key',
};

const validate = (env: Record<string, string | undefined>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const result = validate({});
    const value = result.value as Record<string, string>;
    expect(result.error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage', () => {
  it('should accept the required S3 variables', () => {
    const { error } = validate({});
    expect(error).toBeUndefined();
  });

  it.each(['S3_ENDPOINT', 'S3_PUBLIC_ENDPOINT', 'S3_ACCESS_KEY_ID'])(
    'should reject a missing %s',
    (key) => {
      const { error } = validate({ [key]: undefined });
      expect(error).toBeDefined();
      expect(error!.message).toContain(key);
    },
  );

  it('should reject S3_ENDPOINT that is not a URI', () => {
    const { error } = validate({ S3_ENDPOINT: 'minio:9000 not a uri' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ENDPOINT');
  });

  it('should reject S3_SECRET_ACCESS_KEY shorter than 8 characters', () => {
    const { error } = validate({ S3_SECRET_ACCESS_KEY: 'short' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_SECRET_ACCESS_KEY');
  });

  it('should apply storage defaults', () => {
    const result = validate({});
    const value = result.value as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    expect(value.S3_REGION).toBe('us-east-1');
    expect(value.S3_BUCKET).toBe('streamtube-videos');
  });
});

describe('envValidationSchema — redis', () => {
  it('should apply defaults pointing at the Compose redis service', () => {
    const result = validate({});
    const value = result.value as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    expect(value.REDIS_HOST).toBe('redis');
    expect(value.REDIS_PORT).toBe(6379);
    expect(value.QUEUE_PREFIX).toBe('bull');
  });

  it('should reject REDIS_PORT outside the TCP port range', () => {
    const { error } = validate({ REDIS_PORT: '70000' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('REDIS_PORT');
  });
});

describe('envValidationSchema — video', () => {
  it('should apply video defaults', () => {
    const result = validate({});
    const value = result.value as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    expect(value.VIDEO_WORKER_CONCURRENCY).toBe(1);
    expect(value.VIDEO_SWEEPER_INTERVAL_MS).toBe(900000);
    expect(value.VIDEO_PROCESSING_STUCK_AFTER_MS).toBe(1800000);
    expect(value.VIDEO_UPLOAD_EXPIRE_AFTER_MS).toBe(86400000);
  });

  it('should reject VIDEO_WORKER_CONCURRENCY=0', () => {
    const { error } = validate({ VIDEO_WORKER_CONCURRENCY: '0' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_WORKER_CONCURRENCY');
  });

  it('should reject a non-integer VIDEO_WORKER_CONCURRENCY', () => {
    const { error } = validate({ VIDEO_WORKER_CONCURRENCY: '1.5' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_WORKER_CONCURRENCY');
  });

  it.each([
    'VIDEO_SWEEPER_INTERVAL_MS',
    'VIDEO_PROCESSING_STUCK_AFTER_MS',
    'VIDEO_UPLOAD_EXPIRE_AFTER_MS',
  ])('should reject %s below 1000 ms', (key) => {
    const { error } = validate({ [key]: '999' });
    expect(error).toBeDefined();
    expect(error!.message).toContain(key);
  });
});

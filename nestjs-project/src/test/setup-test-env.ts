// Jest setup file — runs after `dotenv/config` (see `setupFiles` in
// package.json and test/jest-e2e.json).
//
// - Tests run inside the nestjs-api container, so presigned URLs must be
//   signed for the internal endpoint (SigV4 binds the host); the host-facing
//   S3_PUBLIC_ENDPOINT would be unreachable from here.
// - A dedicated BullMQ key prefix keeps in-process test queues/workers away
//   from the jobs of the Compose video-worker.
if (process.env.S3_ENDPOINT) {
  process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;
}
process.env.QUEUE_PREFIX = 'bull-test';

/** The upload service on this stage's bindings (routes/upload, routes/uploads/[id], routes/account). */
import { env } from 'cloudflare:workers';
import { workerGate } from './gate';
import type { UploadDeps } from './uploads';

export const uploadDeps = (origin: string): UploadDeps => ({ db: env.DB, raw: env.RAW, gate: workerGate(env), origin });

import cors from 'cors';
import { config } from './config';

const allowed = new Set(config.corsAllowedOrigins);

/** CORS: whitelist dashboard origins; requests with no `Origin` (curl, server-side proxy) are allowed. */
export const corsMiddleware = cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (allowed.has(origin)) return cb(null, true);
    cb(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: false,
});

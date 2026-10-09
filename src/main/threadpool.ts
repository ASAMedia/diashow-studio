// Imported first by index.ts: libuv reads UV_THREADPOOL_SIZE when its pool is first used. The default
// of 4 caps sharp at 4 images at a time (and queues fs calls behind them) during big imports.
import { availableParallelism } from 'node:os'

if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = String(Math.max(8, Math.min(16, availableParallelism())))

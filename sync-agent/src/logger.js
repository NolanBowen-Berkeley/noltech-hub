// Structured logger for the sync agent.
//   - Writes JSON lines to a daily-rotated file in LOG_DIR (via pino-roll).
//   - Mirrors a pretty, human-readable stream to stdout for `journalctl`/dev use.
// Both streams share the same level (config.LOG_LEVEL).

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pino from 'pino';
import config from './config.js';

const logDir = resolve(config.logDir);

// Ensure the log directory exists; pino-roll won't create parents.
try {
  mkdirSync(logDir, { recursive: true });
} catch (err) {
  // Surface but don't crash — the console transport will still work.
  // eslint-disable-next-line no-console
  console.error(`[logger] Could not create log dir ${logDir}:`, err.message);
}

const transport = pino.transport({
  targets: [
    {
      target: 'pino-roll',
      level: config.logLevel,
      options: {
        file: resolve(logDir, 'sync-agent.log'),
        frequency: 'daily',
        size: '20m',
        mkdir: true,
        dateFormat: 'yyyy-MM-dd',
        // Keep the date suffix on the active file too so rotated names line up.
        extension: '.log',
      },
    },
    {
      target: 'pino-pretty',
      level: config.logLevel,
      options: {
        colorize: true,
        translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
    },
  ],
});

const logger = pino(
  {
    level: config.logLevel,
    base: {
      agent: config.heartbeat.agentId,
      workspace: config.workspaceId,
    },
  },
  transport,
);

export default logger;
export { logger };

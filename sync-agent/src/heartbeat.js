// Writes liveness rows to the `agent_heartbeats` table so the Hub UI can show
// whether the Pi is online and what it's doing. The agent_id column is the
// primary key, so every write is an upsert keyed on this agent's stable ID.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './config.js';
import logger from './logger.js';
import supabase from './supabaseClient.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read version once at module load. package.json is one level above src/.
let agentVersion = '0.0.0';
try {
  const pkgRaw = readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8');
  agentVersion = JSON.parse(pkgRaw).version || agentVersion;
} catch (err) {
  logger.warn({ err: err.message }, 'Could not read package.json for agent version');
}

/**
 * Upsert a heartbeat row. Callable any time — cron tick, run start/end, shutdown.
 *
 * @param {object} opts
 * @param {'idle'|'running'|'ok'|'error'|'shutting-down'} opts.status
 * @param {object|null} [opts.summary]   Arbitrary JSON describing the last run.
 * @param {string|null} [opts.lastError] Optional error string when status='error'.
 */
export async function writeHeartbeat({ status, summary = null, lastError = null } = {}) {
  if (!status) {
    throw new Error('writeHeartbeat: status is required');
  }

  const now = new Date().toISOString();
  const row = {
    agent_id: config.heartbeat.agentId,
    workspace_id: config.workspaceId,
    hostname: config.heartbeat.hostname,
    status,
    last_run_at: now,
    last_run_summary: summary,
    last_error: lastError,
    version: agentVersion,
    updated_at: now,
  };

  const { error } = await supabase
    .from('agent_heartbeats')
    .upsert(row, { onConflict: 'agent_id' });

  if (error) {
    logger.error({ err: error.message, status }, 'Heartbeat write failed');
    return { ok: false, error: error.message };
  }

  logger.debug({ status }, 'Heartbeat written');
  return { ok: true };
}

/** Convenience wrapper used at the start of a sync run. */
export async function markRunStarted() {
  return writeHeartbeat({ status: 'running' });
}

/** Convenience wrapper used at the end of a successful sync run. */
export async function markRunComplete(summary) {
  return writeHeartbeat({ status: 'ok', summary });
}

/** Convenience wrapper used when a run blows up. */
export async function markRunFailed(err) {
  const message = err instanceof Error ? err.message : String(err);
  return writeHeartbeat({ status: 'error', lastError: message });
}

export const AGENT_VERSION = agentVersion;

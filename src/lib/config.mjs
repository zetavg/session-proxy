import path from 'node:path';
import os from 'node:os';

/**
 * Resolve XDG_STATE_HOME, defaulting to ~/.local/state.
 */
function xdgStateHome() {
  return process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
}

/**
 * Resolve a CLI parameter value using the following precedence:
 *   1. Explicit CLI value (if provided and not undefined)
 *   2. Environment variable
 *   3. Built-in default
 *
 * @param {{ cli?: string, env?: string, fallback: string }} opts
 * @returns {string}
 */
export function resolveParam({ cli, env, fallback }) {
  if (cli !== undefined && cli !== null) return cli;
  if (env && process.env[env]) return process.env[env];
  return fallback;
}

/**
 * Resolve the sessions directory path.
 *
 * @param {string} [cliValue] - Value passed via --sessions-dir flag.
 * @returns {string} Absolute path to the sessions directory.
 */
export function resolveSessionsDir(cliValue) {
  const dir = resolveParam({
    cli: cliValue,
    env: 'SESSION_PROXY_SESSIONS_DIR',
    fallback: path.join(xdgStateHome(), 'session-proxy', 'sessions'),
  });
  return path.resolve(dir);
}

/**
 * Resolve the host/address for the proxy server to listen on.
 *
 * @param {string} [cliValue] - Value passed via --host flag.
 * @returns {string}
 */
export function resolveHost(cliValue) {
  return resolveParam({
    cli: cliValue,
    env: 'SESSION_PROXY_HOST',
    fallback: '127.0.0.1',
  });
}

/**
 * Resolve the port for the proxy server.
 *
 * @param {string|number} [cliValue] - Value passed via --port flag.
 * @returns {number}
 */
export function resolvePort(cliValue) {
  const raw = resolveParam({
    cli: cliValue !== undefined && cliValue !== null ? String(cliValue) : undefined,
    env: 'SESSION_PROXY_PORT',
    fallback: '8020',
  });
  const port = Number.parseInt(raw, 10);
  if (Number.isNaN(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return port;
}

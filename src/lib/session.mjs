import path from 'node:path';
import fs from 'node:fs/promises';

/**
 * Resolve a session name or path to an absolute file path.
 *
 * - Absolute paths are returned as-is.
 * - Relative paths / bare names are resolved relative to sessionsDir.
 * - A `.json` extension is appended if not already present.
 *
 * @param {string} nameOrPath - Session name or path.
 * @param {string} sessionsDir - Absolute path to the sessions directory.
 * @returns {string} Absolute path to the session file.
 */
export function resolveSessionPath(nameOrPath, sessionsDir) {
  // Append .json if no extension
  let file = nameOrPath;
  if (!path.extname(file)) {
    file += '.json';
  }

  if (path.isAbsolute(file)) {
    return file;
  }

  return path.join(sessionsDir, file);
}

/**
 * Load session state from a file.
 *
 * @param {string} sessionPath - Absolute path to the session file.
 * @returns {Promise<object>} Parsed session state (Playwright storageState format).
 * @throws If the file does not exist or is not valid JSON.
 */
export async function loadSession(sessionPath) {
  const data = await fs.readFile(sessionPath, 'utf-8');
  return JSON.parse(data);
}

/**
 * Save session state to a file (creates parent directories if needed).
 *
 * @param {string} sessionPath - Absolute path to the session file.
 * @param {object} state - Session state to serialize.
 */
export async function saveSession(sessionPath, state) {
  await fs.mkdir(path.dirname(sessionPath), { recursive: true });
  await fs.writeFile(sessionPath, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Save session state from a Playwright browser context.
 *
 * @param {import('playwright').BrowserContext} context - Playwright browser context.
 * @param {string} sessionPath - Absolute path to the session file.
 */
export async function persistContextSession(context, sessionPath) {
  await fs.mkdir(path.dirname(sessionPath), { recursive: true });
  await context.storageState({ path: sessionPath });
}

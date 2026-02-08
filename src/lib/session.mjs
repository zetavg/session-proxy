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

/**
 * Build a Cookie header string from session state for a given URL.
 *
 * Filters cookies by domain/path matching against the target URL.
 *
 * @param {object} state - Playwright storageState object.
 * @param {string} targetUrl - The URL to match cookies against.
 * @returns {string} Cookie header value (e.g. "name1=val1; name2=val2").
 */
export function buildCookieHeader(state, targetUrl) {
  if (!state.cookies || state.cookies.length === 0) return '';

  const url = new URL(targetUrl);
  const hostname = url.hostname;
  const pathname = url.pathname;

  const matched = state.cookies.filter((c) => {
    // Domain matching: cookie domain ".example.com" matches "sub.example.com"
    const cookieDomain = c.domain.startsWith('.') ? c.domain : `.${c.domain}`;
    const hostDomain = `.${hostname}`;
    if (!hostDomain.endsWith(cookieDomain) && hostDomain !== cookieDomain) {
      return false;
    }

    // Path matching
    if (c.path && !pathname.startsWith(c.path)) {
      return false;
    }

    // Secure flag
    if (c.secure && url.protocol !== 'https:') {
      return false;
    }

    // Expiry check
    if (c.expires && c.expires > 0 && c.expires < Date.now() / 1000) {
      return false;
    }

    return true;
  });

  return matched.map((c) => `${c.name}=${c.value}`).join('; ');
}

import path from 'node:path';
import fs from 'node:fs/promises';

/**
 * Resolve a session name or path to an absolute file path.
 *
 * - Names and relative paths are resolved relative to sessionsDir.
 * - A `.json` extension is appended if not already present.
 * - Absolute paths are rejected.
 * - Path traversal beyond the sessions directory is blocked.
 *
 * @param {string} nameOrPath - Session name or relative path.
 * @param {string} sessionsDir - Absolute path to the sessions directory.
 * @returns {string} Absolute path to the session file.
 * @throws If the path is absolute or escapes the sessions directory.
 */
export function resolveSessionPath(nameOrPath, sessionsDir) {
  if (path.isAbsolute(nameOrPath)) {
    throw new Error(`Absolute session paths are not allowed: ${nameOrPath}`);
  }

  // Append .json if no extension
  let file = nameOrPath;
  if (!path.extname(file)) {
    file += '.json';
  }

  const resolved = path.resolve(sessionsDir, file);
  const normalizedDir = path.resolve(sessionsDir) + path.sep;

  if (!resolved.startsWith(normalizedDir) && resolved !== path.resolve(sessionsDir)) {
    throw new Error(`Session path escapes the sessions directory: ${nameOrPath}`);
  }

  return resolved;
}

/**
 * Check the permissions of a session file and fix them if they are too
 * permissive. Session files should be owner-only (0o600) since they contain
 * sensitive authentication data. Group/other read, write, or execute bits
 * are removed automatically with a warning.
 *
 * @param {string} filePath - Absolute path to the file to check.
 */
async function ensureSafePermissions(filePath) {
  try {
    const stat = await fs.stat(filePath);
    // mode includes file-type bits; mask to permission bits only
    const perm = stat.mode & 0o777;
    const groupOtherBits = perm & 0o077;
    if (groupOtherBits !== 0) {
      console.warn(`⚠️  Session file ${filePath} has overly permissive mode ${perm.toString(8)} — fixing to 600.`);
      await fs.chmod(filePath, 0o600);
    }
  } catch {
    // File may not exist yet — ignore
  }
}

/**
 * Load session state from a file.
 * Checks and fixes file permissions if they are too permissive.
 *
 * @param {string} sessionPath - Absolute path to the session file.
 * @returns {Promise<object>} Parsed session state (Playwright storageState format).
 * @throws If the file does not exist or is not valid JSON.
 */
export async function loadSession(sessionPath) {
  await ensureSafePermissions(sessionPath);
  const data = await fs.readFile(sessionPath, 'utf-8');
  return JSON.parse(data);
}

/**
 * Save session state to a file (creates parent directories if needed).
 * Files are written with mode 0o600 (owner-only read/write) to protect
 * sensitive session data.
 *
 * @param {string} sessionPath - Absolute path to the session file.
 * @param {object} state - Session state to serialize.
 */
export async function saveSession(sessionPath, state) {
  await fs.mkdir(path.dirname(sessionPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(sessionPath, JSON.stringify(state, null, 2), { encoding: 'utf-8', mode: 0o600 });
  await ensureSafePermissions(sessionPath);
}

/**
 * Save session state from a Playwright browser context.
 * Files are written with mode 0o600 (owner-only read/write) to protect
 * sensitive session data.
 *
 * @param {import('playwright').BrowserContext} context - Playwright browser context.
 * @param {string} sessionPath - Absolute path to the session file.
 */
export async function persistContextSession(context, sessionPath) {
  await fs.mkdir(path.dirname(sessionPath), { recursive: true, mode: 0o700 });
  await context.storageState({ path: sessionPath });
  // Playwright writes with default permissions — ensure owner-only
  await ensureSafePermissions(sessionPath);
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

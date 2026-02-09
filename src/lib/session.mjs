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
 * If the session file is corrupted or missing, this function will attempt
 * to recover from any leftover temp files before giving up.
 *
 * @param {string} sessionPath - Absolute path to the session file.
 * @returns {Promise<object>} Parsed session state (Playwright storageState format).
 * @throws If the file does not exist or contains invalid/corrupted JSON.
 */
export async function loadSession(sessionPath) {
  await ensureSafePermissions(sessionPath);

  // Check for temp files first — if they exist, they represent a newer
  // write that was interrupted before the atomic rename completed.
  // A valid temp file should take priority over the main file.
  const recovered = await recoverFromTempFiles(sessionPath);
  if (recovered !== null) {
    return recovered;
  }

  // No temp files (or none were valid) — load the main session file.
  let data;
  try {
    data = await fs.readFile(sessionPath, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `Session file not found: ${path.basename(sessionPath)}. ` +
        `Use the "init" command to create it.`
      );
    }
    throw new Error(
      `Session file is corrupted or incomplete (${path.basename(sessionPath)}). ` +
      `You may need to re-initialize this session with the "init" command.`
    );
  }
}

/**
 * Attempt to recover a session from leftover temp files.
 *
 * Finds all temp files for the given session path, tries to parse each one
 * as JSON (newest first), and if a valid one is found, promotes it to the
 * main session file and cleans up the rest.
 *
 * @param {string} sessionPath - Absolute path to the session file.
 * @returns {Promise<object|null>} Recovered session state, or null if no
 *   valid temp file was found.
 */
async function recoverFromTempFiles(sessionPath) {
  const dir = path.dirname(sessionPath);
  const base = path.basename(sessionPath);
  let tempFiles;
  try {
    const allFiles = await fs.readdir(dir);
    tempFiles = allFiles
      .filter((f) => f.startsWith(base + '.tmp.'))
      .sort()
      .reverse(); // newest first (filenames contain timestamps)
  } catch {
    return null; // directory doesn't exist
  }

  if (tempFiles.length === 0) return null;

  for (const tmpName of tempFiles) {
    const tmpPath = path.join(dir, tmpName);
    try {
      const tmpData = await fs.readFile(tmpPath, 'utf-8');
      const parsed = JSON.parse(tmpData);

      // Valid JSON — promote to main file via atomic rename.
      await fs.rename(tmpPath, sessionPath);
      await ensureSafePermissions(sessionPath);
      console.warn(`♻️  Recovered session from temp file: ${tmpName}`);

      // Clean up remaining temp files.
      await cleanupTempFiles(sessionPath);
      return parsed;
    } catch {
      // This temp file is also invalid — remove it and try the next one.
      try { await fs.unlink(tmpPath); } catch { /* ignore */ }
      console.warn(`🧹 Removed invalid temp file: ${tmpName}`);
    }
  }

  return null;
}

/**
 * Remove any leftover temp files from interrupted atomic writes.
 *
 * @param {string} sessionPath - Absolute path to the session file.
 */
async function cleanupTempFiles(sessionPath) {
  const dir = path.dirname(sessionPath);
  const base = path.basename(sessionPath);
  try {
    const files = await fs.readdir(dir);
    for (const f of files) {
      if (f.startsWith(base + '.tmp.')) {
        try {
          await fs.unlink(path.join(dir, f));
          console.warn(`🧹 Cleaned up stale temp file: ${f}`);
        } catch { /* ignore */ }
      }
    }
  } catch { /* directory may not exist yet */ }
}

/**
 * Save session state to a file (creates parent directories if needed).
 * Files are written with mode 0o600 (owner-only read/write) to protect
 * sensitive session data.
 *
 * Uses atomic write (write to temp file, then rename) to prevent
 * incomplete/corrupted files if the process is interrupted mid-write.
 *
 * @param {string} sessionPath - Absolute path to the session file.
 * @param {object} state - Session state to serialize.
 */
export async function saveSession(sessionPath, state) {
  const dir = path.dirname(sessionPath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmpPath = sessionPath + `.tmp.${process.pid}.${Date.now()}`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), { encoding: 'utf-8', mode: 0o600 });
    await fs.rename(tmpPath, sessionPath);
  } catch (err) {
    // Clean up temp file on failure
    try { await fs.unlink(tmpPath); } catch { /* ignore */ }
    throw err;
  }
  await ensureSafePermissions(sessionPath);
}

/**
 * Save session state from a Playwright browser context.
 * Files are written with mode 0o600 (owner-only read/write) to protect
 * sensitive session data.
 *
 * Uses atomic write (write to temp file, then rename) to prevent
 * incomplete/corrupted files if the process is interrupted mid-write.
 *
 * @param {import('playwright').BrowserContext} context - Playwright browser context.
 * @param {string} sessionPath - Absolute path to the session file.
 */
export async function persistContextSession(context, sessionPath) {
  const dir = path.dirname(sessionPath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmpPath = sessionPath + `.tmp.${process.pid}.${Date.now()}`;
  try {
    await context.storageState({ path: tmpPath });
    await fs.rename(tmpPath, sessionPath);
  } catch (err) {
    // Clean up temp file on failure
    try { await fs.unlink(tmpPath); } catch { /* ignore */ }
    throw err;
  }
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

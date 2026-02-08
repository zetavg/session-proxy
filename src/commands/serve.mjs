import http from 'node:http';
import https from 'node:https';
import { defineCommand } from 'citty';
import { resolveSessionsDir, resolvePort } from '../lib/config.mjs';
import { resolveSessionPath, loadSession, persistContextSession, buildCookieHeader } from '../lib/session.mjs';
import { launchBrowser, createContext } from '../lib/browser.mjs';

export default defineCommand({
  meta: {
    name: 'serve',
    description: 'Start the proxy server for authenticated requests using stored sessions.',
  },
  args: {
    port: {
      type: 'string',
      alias: 'p',
      description: 'Port to bind the HTTP server to. Default: 8080.',
    },
    'sessions-dir': {
      type: 'string',
      description: 'Path to the sessions directory.',
    },
  },
  async run({ args }) {
    const sessionsDir = resolveSessionsDir(args['sessions-dir']);
    const port = resolvePort(args.port);

    console.log(`📂 Sessions directory: ${sessionsDir}`);

    // Browser instance shared across requests
    const browser = await launchBrowser();

    // Cache of active browser contexts keyed by session path
    /** @type {Map<string, import('playwright').BrowserContext>} */
    const contextCache = new Map();

    /**
     * Get or create a browser context for the given session.
     * @param {string} sessionPath
     * @returns {Promise<import('playwright').BrowserContext>}
     */
    async function getContext(sessionPath) {
      if (contextCache.has(sessionPath)) {
        return contextCache.get(sessionPath);
      }

      const storageState = await loadSession(sessionPath);
      const context = await createContext(browser, {
        storageState,
        acceptDownloads: true,
      });
      contextCache.set(sessionPath, context);
      return context;
    }

    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url, `http://localhost:${port}`);

        // Only handle /v1 endpoint
        if (reqUrl.pathname !== '/v1') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found. Use /v1?session=<name>&url=<encoded_url>' }));
          return;
        }

        const sessionName = reqUrl.searchParams.get('session');
        const targetUrl = reqUrl.searchParams.get('url');

        if (!sessionName || !targetUrl) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing required query parameters: session, url' }));
          return;
        }

        const sessionPath = resolveSessionPath(sessionName, sessionsDir);
        console.log(`📥 [${sessionName}] ${targetUrl}`);

        // Phase 1: Try a direct HTTP request with session cookies.
        // This gives us real streaming — the client receives bytes as they arrive.
        const state = await loadSession(sessionPath);
        const cookieHeader = buildCookieHeader(state, targetUrl);

        const upstreamRes = await directFetch(targetUrl, cookieHeader);
        const contentType = upstreamRes.headers['content-type'] || '';
        const isHtmlPage = contentType.includes('text/html');

        if (!isHtmlPage) {
          // Non-HTML (file download, JSON, etc.) — stream directly to client.
          const headers = { ...upstreamRes.headers };

          // Forward Content-Disposition if present, otherwise synthesize one
          // for non-text responses to signal a file download.
          if (!headers['content-disposition'] && !contentType.startsWith('text/')) {
            const filename = filenameFromUrl(targetUrl);
            headers['content-disposition'] = `attachment; filename="${filename}"`;
          }

          res.writeHead(upstreamRes.statusCode, headers);
          upstreamRes.pipe(res);

          // Persist any Set-Cookie headers back into the session file
          await updateSessionCookies(state, sessionPath, upstreamRes, targetUrl);

          console.log(`✅ [${sessionName}] Streamed ${targetUrl}`);
          return;
        }

        // Phase 2: HTML page — use Playwright for full rendering.
        // Destroy the direct response since we won't use it.
        upstreamRes.destroy();

        const context = await getContext(sessionPath);
        const page = await context.newPage();

        try {
          await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 60000 });
          const body = await page.content();

          await persistContextSession(context, sessionPath);

          res.writeHead(200, { 'Content-Type': contentType || 'text/html; charset=utf-8' });
          res.end(body);
          console.log(`✅ [${sessionName}] Rendered ${targetUrl}`);
        } finally {
          await page.close();
        }
      } catch (err) {
        console.error('❌ Request failed:', err.message || err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message || 'Internal server error' }));
        }
      }
    });

    server.listen(port, () => {
      console.log(`🚀 Session proxy listening on http://localhost:${port}`);
      console.log(`   Example: curl "http://localhost:${port}/v1?session=example&url=https%3A%2F%2Fexample.com"`);
    });

    // Graceful shutdown
    const shutdown = async () => {
      console.log('\n🛑 Shutting down...');
      server.close();
      for (const [sessionPath, context] of contextCache) {
        try {
          await persistContextSession(context, sessionPath);
          await context.close();
        } catch {
          // Best-effort cleanup
        }
      }
      await browser.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Keep the process alive
    await new Promise(() => {});
  },
});

/**
 * Perform a direct HTTP(S) GET request with cookies, returning the raw
 * IncomingMessage response for streaming.
 *
 * @param {string} url - Target URL.
 * @param {string} cookieHeader - Cookie header value.
 * @returns {Promise<import('http').IncomingMessage>}
 */
function directFetch(url, cookieHeader) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;

    const reqOpts = {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
    };

    const req = mod.get(url, reqOpts, (res) => {
      // Follow redirects (3xx)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.destroy();
        const redirectUrl = new URL(res.headers.location, url).toString();
        directFetch(redirectUrl, cookieHeader).then(resolve, reject);
        return;
      }
      resolve(res);
    });

    req.on('error', reject);
  });
}

/**
 * Extract a reasonable filename from a URL path.
 *
 * @param {string} url
 * @returns {string}
 */
function filenameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const base = pathname.split('/').pop();
    return base || 'download';
  } catch {
    return 'download';
  }
}

/**
 * If the upstream response includes Set-Cookie headers, merge them back into
 * the session state and persist to disk.
 *
 * @param {object} state - Loaded session state.
 * @param {string} sessionPath - Path to the session file.
 * @param {import('http').IncomingMessage} upstreamRes - The upstream HTTP response.
 * @param {string} targetUrl - The original target URL.
 */
async function updateSessionCookies(state, sessionPath, upstreamRes, targetUrl) {
  const setCookieHeaders = upstreamRes.headers['set-cookie'];
  if (!setCookieHeaders || setCookieHeaders.length === 0) return;

  const url = new URL(targetUrl);

  for (const raw of setCookieHeaders) {
    const parts = raw.split(';').map((s) => s.trim());
    const [nameVal, ...attrs] = parts;
    const eqIdx = nameVal.indexOf('=');
    if (eqIdx < 0) continue;

    const name = nameVal.slice(0, eqIdx);
    const value = nameVal.slice(eqIdx + 1);

    const cookie = { name, value, domain: url.hostname, path: '/' };

    for (const attr of attrs) {
      const lower = attr.toLowerCase();
      if (lower.startsWith('domain=')) {
        cookie.domain = attr.slice(7);
      } else if (lower.startsWith('path=')) {
        cookie.path = attr.slice(5);
      } else if (lower === 'secure') {
        cookie.secure = true;
      } else if (lower === 'httponly') {
        cookie.httpOnly = true;
      } else if (lower.startsWith('expires=')) {
        const ts = Date.parse(attr.slice(8));
        if (!Number.isNaN(ts)) cookie.expires = ts / 1000;
      } else if (lower.startsWith('samesite=')) {
        cookie.sameSite = attr.slice(9);
      }
    }

    // Replace existing cookie with same name + domain, or append
    const idx = (state.cookies || []).findIndex(
      (c) => c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path,
    );
    if (!state.cookies) state.cookies = [];
    if (idx >= 0) {
      state.cookies[idx] = cookie;
    } else {
      state.cookies.push(cookie);
    }
  }

  // Persist updated state
  const { saveSession } = await import('../lib/session.mjs');
  await saveSession(sessionPath, state);
}

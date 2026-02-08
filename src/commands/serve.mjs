import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { defineCommand } from 'citty';
import { resolveSessionsDir, resolvePort } from '../lib/config.mjs';
import { resolveSessionPath, loadSession, persistContextSession } from '../lib/session.mjs';
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

        const context = await getContext(sessionPath);
        const page = await context.newPage();

        try {
          const result = await handleRequest(page, targetUrl);

          // Persist updated session state (cookies may have been refreshed)
          await persistContextSession(context, sessionPath);

          if (result.type === 'download') {
            // Wait for the download to complete and get the temp file path
            const { download } = result;
            const tempPath = await download.path();
            const suggestedName = download.suggestedFilename();
            const { size } = await fsp.stat(tempPath);

            res.writeHead(200, {
              'Content-Type': 'application/octet-stream',
              'Content-Disposition': `attachment; filename="${suggestedName}"`,
              'Content-Length': size,
            });
            fs.createReadStream(tempPath).pipe(res);
          } else {
            // Return rendered HTML content
            const contentType = result.contentType || 'text/html; charset=utf-8';
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(result.body);
          }
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
 * Navigate to a URL and determine whether it triggers a download or is a page.
 *
 * @param {import('playwright').Page} page
 * @param {string} url
 * @returns {Promise<{ type: 'download', download: import('playwright').Download } | { type: 'page', body: string, contentType?: string }>}
 */
async function handleRequest(page, url) {
  // Set up a download listener before navigation
  /** @type {import('playwright').Download | null} */
  let download = null;
  const downloadPromise = new Promise((resolve) => {
    page.once('download', (d) => {
      download = d;
      resolve(d);
    });
  });

  // Navigate — this may throw ERR_ABORTED if the response triggers a download
  let response = null;
  try {
    response = await Promise.race([
      page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }),
      downloadPromise.then(() => null), // resolve navigation race if download starts
    ]);
  } catch (err) {
    // If navigation was aborted due to a download, wait for it
    if (!download) {
      // Give the download event a moment to fire
      await Promise.race([
        downloadPromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(err), 5000),
        ),
      ]);
    }
  }

  if (download) {
    return { type: 'download', download };
  }

  const contentType = await response?.headerValue('content-type');
  const body = await page.content();
  return { type: 'page', body, contentType };
}

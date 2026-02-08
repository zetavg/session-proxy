import http from 'node:http';
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
            // Stream the downloaded file back
            const { download } = result;
            const readable = await download.createReadStream();
            const suggestedName = download.suggestedFilename();

            res.writeHead(200, {
              'Content-Type': 'application/octet-stream',
              'Content-Disposition': `attachment; filename="${suggestedName}"`,
            });
            readable.pipe(res);
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
  const downloadPromise = new Promise((resolve) => {
    page.once('download', (download) => resolve(download));
  });

  // Race between page load and download
  const navigationPromise = page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

  const result = await Promise.race([
    downloadPromise.then((download) => ({ type: 'download', download })),
    navigationPromise.then(async (response) => {
      const contentType = response?.headerValue('content-type');
      const body = await page.content();
      return { type: 'page', body, contentType: await contentType };
    }),
  ]);

  return result;
}

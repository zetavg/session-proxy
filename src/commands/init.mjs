import { defineCommand } from 'citty';

import { createContext, launchBrowser } from '../lib/browser.mjs';
import { resolveSessionsDir } from '../lib/config.mjs';
import { persistContextSession, resolveSessionPath } from '../lib/session.mjs';

export default defineCommand({
  meta: {
    name: 'init',
    description:
      'Initialize a session by performing an interactive browser login.',
  },
  args: {
    session: {
      type: 'string',
      alias: 's',
      description:
        'Name or relative path of the session file to create or overwrite (resolved within the sessions directory).',
      required: true,
    },
    url: {
      type: 'string',
      alias: 'u',
      description: 'Login URL to open in the browser.',
      required: true,
    },
    'sessions-dir': {
      type: 'string',
      description: 'Path to the sessions directory.',
    },
  },
  async run({ args }) {
    const sessionsDir = resolveSessionsDir(args['sessions-dir']);
    const sessionPath = resolveSessionPath(args.session, sessionsDir);

    console.log(`📂 Session will be saved to: ${sessionPath}`);

    const browser = await launchBrowser({ headless: false });
    const context = await createContext(browser);
    const page = await context.newPage();

    await page.goto(args.url);
    console.log(`🌐 Opened: ${args.url}`);
    console.log(
      '👤 Please log in manually. Close the browser window when done.',
    );

    // Track open pages. When the user closes the last tab/window,
    // the context is still alive so we can reliably capture state,
    // then close the browser ourselves.
    const pages = new Set(context.pages());

    context.on('page', (p) => {
      pages.add(p);
      p.on('close', () => pages.delete(p));
    });
    page.on('close', () => pages.delete(page));

    await new Promise((resolve) => {
      const onPageClose = async () => {
        if (pages.size > 0) return;

        // All tabs closed — save session while context is still alive
        try {
          await persistContextSession(context, sessionPath);
          console.log(`✅ Session saved to: ${sessionPath}`);
        } catch (err) {
          console.error('❌ Failed to save session:', err.message || err);
        }

        await browser.close();
        resolve();
      };

      // Listen for close on the initial page and any future pages
      page.on('close', onPageClose);
      context.on('page', (p) => {
        p.on('close', onPageClose);
      });

      // Also resolve if the browser is closed externally (e.g. killed)
      browser.on('disconnected', resolve);
    });
  },
});

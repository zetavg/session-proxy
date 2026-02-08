import { defineCommand } from 'citty';
import { resolveSessionsDir } from '../lib/config.mjs';
import { resolveSessionPath, persistContextSession } from '../lib/session.mjs';
import { launchBrowser, createContext } from '../lib/browser.mjs';

export default defineCommand({
  meta: {
    name: 'init',
    description: 'Initialize a session by performing an interactive browser login.',
  },
  args: {
    session: {
      type: 'string',
      alias: 's',
      description: 'Name or path of the session file to create or overwrite.',
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
    console.log('👤 Please log in manually. Close the browser window when done.');

    // Periodically persist session state so we capture the latest state
    // even if the browser is abruptly closed.
    const saveInterval = setInterval(async () => {
      try {
        await persistContextSession(context, sessionPath);
      } catch {
        // Context may already be closed — ignore.
      }
    }, 3000);

    // Wait until the browser is closed by the user
    await new Promise((resolve) => {
      browser.on('disconnected', resolve);
    });

    clearInterval(saveInterval);

    // Final save attempt (may fail if already disconnected, which is fine
    // because the interval will have captured a recent state).
    try {
      await persistContextSession(context, sessionPath);
    } catch {
      // Already disconnected — the last interval save is our best state.
    }

    console.log(`✅ Session saved to: ${sessionPath}`);
  },
});

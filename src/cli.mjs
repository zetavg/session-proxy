import { defineCommand, runMain } from 'citty';
import initCommand from './commands/init.mjs';
import serveCommand from './commands/serve.mjs';

const main = defineCommand({
  meta: {
    name: 'session-proxy',
    version: '1.0.0',
    description: 'A local HTTP proxy that reuses browser session state for authenticated requests.',
  },
  subCommands: {
    init: initCommand,
    serve: serveCommand,
  },
});

runMain(main);

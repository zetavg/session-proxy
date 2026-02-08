import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';

// Register stealth plugin once
let stealthRegistered = false;

/**
 * Ensure the stealth plugin is registered with playwright-extra's chromium.
 */
function ensureStealth() {
  if (!stealthRegistered) {
    chromium.use(stealthPlugin());
    stealthRegistered = true;
  }
}

/**
 * Launch a stealth-enabled Chromium browser.
 *
 * @param {import('playwright').LaunchOptions} [opts] - Playwright launch options.
 * @returns {Promise<import('playwright').Browser>}
 */
export async function launchBrowser(opts = {}) {
  ensureStealth();
  return chromium.launch(opts);
}

/**
 * Create a new browser context, optionally restoring session state.
 *
 * @param {import('playwright').Browser} browser
 * @param {object} [options]
 * @param {object} [options.storageState] - Playwright storage state to restore.
 * @param {boolean} [options.acceptDownloads] - Whether to accept downloads.
 * @returns {Promise<import('playwright').BrowserContext>}
 */
export async function createContext(browser, options = {}) {
  return browser.newContext(options);
}

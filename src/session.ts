import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type BrowserContext, type Cookie, type Page } from 'playwright';

/** What a --login script exports: sign in on the page it is given. */
export type LoginScript = (page: Page, context: BrowserContext) => Promise<void>;

/**
 * Opens a visible browser at the URL, waits while you sign in by hand (any way the site
 * offers, GitHub and two-factor included), then saves the cookies and local storage to a file
 * that --session can start from.
 */
export async function saveSession(url: string, file: string, log: (message: string) => void = console.log,
  testing: { headless?: boolean; whileOpen?: (page: Page) => Promise<void> } = {}): Promise<void> {
  const browser = await chromium.launch({ headless: testing.headless ?? false });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(url);
    // Tests stand in for the person here: sign in, then close the window.
    if (testing.whileOpen) void testing.whileOpen(page).catch(() => {});
    log('Sign in in the browser window. Once you are signed in, press Enter here or just close the browser.');

    // Keep a fresh copy of the session while the window is open, so closing it still saves the sign-in
    // (and so this works where the terminal can't pass Enter through).
    let latest = await context.storageState();
    const snapshot = setInterval(() => {
      context.storageState().then(state => { latest = state; }, () => {});
    }, 1000);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    // Closing the last window doesn't end a browser Playwright launched, so watch the pages too.
    const closed = new Promise<void>(resolve => {
      browser.once('disconnected', () => resolve());
      const watch = (p: Page) => p.once('close', () => { if (context.pages().length === 0) resolve(); });
      context.pages().forEach(watch);
      context.on('page', watch);
    });
    // With no terminal attached, stdin ends at once; then only closing the browser counts.
    const entered = rl.question('').then(() => {}, () => new Promise<void>(() => {}));    await Promise.race([entered, closed]);
    clearInterval(snapshot);
    rl.close();
    if (browser.isConnected()) latest = await context.storageState();
    // Signing in through GitHub or Google leaves their cookies too: a login to that account. Keep only this site's.
    const host = new URL(url).hostname;
    const kept = forSite(latest, host);
    const dropped = new Set(latest.cookies.filter(c => !kept.cookies.includes(c)).map(c => c.domain.replace(/^\./, '')));
    await writeFile(file, JSON.stringify(kept, null, 2));
    if (dropped.size) log(`Left out the cookies for ${[...dropped].join(', ')}: the gremlin only needs ${host}'s.`);
    latest = kept;
    if (latest.cookies.length === 0) log('Warning: the session has no cookies, so it probably isn\'t signed in.');
    log(`Saved the session to ${file}. It holds your sign-in cookies, so treat it like a password: don't commit or share it.`);
  } finally {
    await browser.close().catch(() => {});
  }
}

type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

/** Only the cookies and local storage that belong to the host (or a domain above it). */
export function forSite(state: StorageState, host: string): StorageState {
  const ours = (domain: string) => {
    const d = domain.replace(/^\./, '');
    return host === d || host.endsWith(`.${d}`);
  };
  return {
    ...state,
    cookies: state.cookies.filter(c => ours(c.domain)),
    origins: state.origins.filter(o => new URL(o.origin).hostname === host),
  };
}

/** Loads a --login script (a .js or .mjs module whose default export signs in) and runs it. */
export async function runLoginScript(file: string, page: Page, context: BrowserContext): Promise<void> {
  const mod = await import(pathToFileURL(path.resolve(file)).href);
  const login = (mod.default ?? mod.login) as LoginScript | undefined;
  if (typeof login !== 'function') {
    throw new Error(`${file} must export a function: export default async (page) => { /* sign in */ }`);
  }
  await login(page, context);
}

/** Cookies for the hosts being explored, keyed by name and domain so one that disappears can be spotted. */
export function cookieKeys(cookies: Cookie[], allow: string[]): Set<string> {
  const hosts = allow.map(h => h.replace(/:\d+$/, '').replace(/^\[|\]$/g, ''));
  const ours = (domain: string) => {
    const d = domain.replace(/^\./, '');
    return hosts.some(h => h === d || h.endsWith(`.${d}`));
  };
  return new Set(cookies.filter(c => ours(c.domain)).map(c => `${c.name} (${c.domain})`));
}

/** The session cookies from the start of the run that are no longer there. */
export function lostCookies(start: Set<string>, now: Set<string>): string[] {
  return [...start].filter(key => !now.has(key));
}

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseOptions, parseSaveSession } from '../src/cli.js';
import { explore } from '../src/explore.js';
import { reproTest, writeReport } from '../src/report.js';
import { skipReason, type Candidate } from '../src/actions.js';
import { cookieKeys, forSite, lostCookies, saveSession } from '../src/session.js';
import type { Finding, Options } from '../src/types.js';
import { startBuggySite, type BuggySite } from './fixtures/buggy-site.js';

let site: BuggySite;
let dir: string;
let sessionFile: string;

const options = (overrides: Partial<Options>): Options => ({
  startUrl: `${site.url}members`,
  allow: [new URL(site.url).host],
  maxActions: 25,
  maxMinutes: 2,
  seed: 3,
  submitForms: false,
  unsafe: false,
  mobile: false,
  headed: false,
  outDir: path.join(dir, `run-${Math.random().toString(36).slice(2)}`),
  failOn: 'high',
  ...overrides,
});

beforeAll(async () => {
  site = await startBuggySite();
  dir = await mkdtemp(path.join(os.tmpdir(), 'gremlin-session-'));
  // What save-session writes: Playwright storage state, here holding the members' cookie.
  sessionFile = path.join(dir, 'session.json');
  await writeFile(sessionFile, JSON.stringify({
    cookies: [{ name: 'member', value: 'yes', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }],
    origins: [],
  }));
});

afterAll(async () => {
  await site?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

const vaultError = (findings: Finding[]) => findings.some(f => f.kind === 'page-error' && f.url.includes('/members/vault'));

describe('exploring signed in', () => {
  it('reaches members-only pages from a saved session, and stays signed in', async () => {
    const opts = options({ session: sessionFile });
    const result = await explore(opts);
    expect(result.pagesVisited).toContain(`${site.url}members/vault`);
    expect(vaultError(result.findings)).toBe(true);
    // "Sign out" looks destructive, so the gremlin leaves it alone.
    expect(site.hits.get('/members/sign-out') ?? 0).toBe(0);
    expect(result.signedOut).toBeUndefined();

    await writeReport(result, opts);
    const finding = result.findings.find(f => f.url.includes('/members/vault'))!;
    const repro = await readFile(path.join(opts.outDir, 'repro', `finding-${finding.id}.spec.ts`), 'utf8');
    expect(repro).toContain(`test.use({ storageState: ${JSON.stringify(sessionFile.replace(/\\/g, '/'))} })`);
  }, 120_000);

  it('without a session, the members area is out of reach', async () => {
    const result = await explore(options({}));
    expect(result.pagesVisited.some(url => url.includes('/members'))).toBe(false);
    expect(vaultError(result.findings)).toBe(false);
  }, 120_000);

  it('signs in with a login script', async () => {
    const script = path.join(dir, 'login.mjs');
    await writeFile(script, `export default async page => {
      await page.goto(${JSON.stringify(`${site.url}login`)});
      await page.getByLabel('User').fill('gremlin');
      await page.getByLabel('Password').fill('letmein');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL('**/members');
    };`);
    const result = await explore(options({ loginScript: script }));
    expect(vaultError(result.findings)).toBe(true);
    expect(result.signedOut).toBeUndefined();
  }, 120_000);

  it('says when the session ends partway through', async () => {
    const result = await explore(options({ session: sessionFile, startUrl: `${site.url}members/expire`, maxActions: 5 }));
    expect(result.signedOut?.cookies).toEqual(['member (127.0.0.1)']);
  }, 120_000);

  it('reports a login script that fails', async () => {
    const script = path.join(dir, 'broken-login.mjs');
    await writeFile(script, 'export default async () => { throw new Error("no such button"); };');
    await expect(explore(options({ loginScript: script }))).rejects.toThrow('The login script failed: no such button');
  }, 60_000);
});

describe('save-session', () => {
  it('saves the sign-in when the window is closed', async () => {
    const file = path.join(dir, 'saved.json');
    await saveSession(`${site.url}login`, file, () => {}, {
      headless: true,
      whileOpen: async page => {
        await page.getByLabel('User').fill('gremlin');
        await page.getByLabel('Password').fill('letmein');
        await page.getByRole('button', { name: 'Sign in' }).click();
        await page.waitForURL('**/members');
        await page.close();
      },
    });
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved.cookies.map((c: { name: string }) => c.name)).toContain('member');
  }, 60_000);
});

describe('session options', () => {
  it('needs the session file to exist, and takes one way of signing in', () => {
    expect(parseOptions(['http://localhost:3000', '--session', path.join(os.tmpdir(), 'nope.json')])).toMatchObject({ error: expect.stringContaining('save-session') });
    expect(parseOptions(['http://localhost:3000', '--session', sessionFile, '--login', sessionFile])).toEqual({ error: 'Use --session or --login, not both.' });
    expect(parseOptions(['http://localhost:3000', '--session', sessionFile])).toMatchObject({ session: sessionFile });
  });

  it('parses save-session', () => {
    expect(parseSaveSession(['http://localhost:3000/login'])).toEqual({ url: 'http://localhost:3000/login', file: 'gremlin-session.json' });
    expect(parseSaveSession(['http://localhost:3000/', '--to', 'me.json'])).toMatchObject({ file: 'me.json' });
    expect(parseSaveSession([])).toMatchObject({ error: expect.any(String) });
  });

  it('only watches cookies for the hosts being explored', () => {
    const cookie = (name: string, domain: string) => ({ name, domain, value: '', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const });
    const keys = cookieKeys([cookie('a', 'app.example.com'), cookie('b', '.example.com'), cookie('c', 'github.com')], ['app.example.com:443']);
    expect([...keys]).toEqual(['a (app.example.com)', 'b (.example.com)']);
    expect(lostCookies(keys, new Set(['b (.example.com)']))).toEqual(['a (app.example.com)']);
  });

  it('keeps only the signed-in site\'s cookies, not the sign-in provider\'s', () => {
    const cookie = (name: string, domain: string) => ({ name, domain, value: 'x', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const });
    const kept = forSite({
      cookies: [cookie('app', 'app.example.com'), cookie('shared', '.example.com'), cookie('user_session', 'github.com')],
      origins: [{ origin: 'https://app.example.com', localStorage: [] }, { origin: 'https://github.com', localStorage: [] }],
    }, 'app.example.com');
    expect(kept.cookies.map(c => c.name)).toEqual(['app', 'shared']);
    expect(kept.origins.map(o => o.origin)).toEqual(['https://app.example.com']);
  });

  it('leaves --avoid labels alone, even with --unsafe', () => {
    const button = { role: 'button', label: 'button "Put me on the leaderboard"' } as Candidate;
    const opts = { allow: ['x'], submitForms: true, unsafe: true };
    expect(skipReason(button, { ...opts, avoid: ['LEADERBOARD'] })).toBe('on the --avoid list');
    expect(skipReason(button, opts)).toBeUndefined();
    expect(parseOptions(['http://localhost:3000', '--avoid', 'XP', '--avoid', 'leaderboard'])).toMatchObject({ avoid: ['XP', 'leaderboard'] });
  });

  it('notes a login script in the repro test', () => {
    const finding: Finding = { id: 1, kind: 'page-error', severity: 'medium', title: 't', detail: 'd', url: 'http://x/', steps: [{ kind: 'goto', url: 'http://x/' }], seen: 1 };
    expect(reproTest(finding, { loginScript: 'login.mjs' })).toContain('signed in by login.mjs');
    expect(reproTest(finding)).not.toContain('signed in');
  });
});

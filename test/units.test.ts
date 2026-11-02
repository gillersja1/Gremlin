import { describe, expect, it } from 'vitest';
import { skipReason, type Candidate } from '../src/actions.js';
import { parseOptions } from '../src/cli.js';
import { marker, markersIn } from '../src/payloads.js';
import { Random } from '../src/random.js';
import { reproTest } from '../src/report.js';
import type { Finding } from '../src/types.js';

const opts = { allow: ['localhost:3000'], submitForms: false, unsafe: false };
const link = (href: string, label = 'Somewhere'): Candidate => ({ selector: 'a', role: 'link', label, type: '', href, submits: false });
const button = (label: string, submits = false): Candidate => ({ selector: 'button', role: 'button', label, type: '', submits });

describe('skipReason', () => {
  it('stays on the allowed hosts', () => {
    expect(skipReason(link('http://localhost:3000/about'), opts)).toBeUndefined();
    expect(skipReason(link('https://example.com/'), opts)).toBe('leaves the allowed hosts');
    expect(skipReason(link('mailto:someone@example.com'), opts)).toBe('leaves the allowed hosts');
  });

  it('leaves destructive-looking controls alone unless told otherwise', () => {
    for (const label of ['Delete account', 'Pay now', 'Log out', 'Sign out', 'Checkout', 'Unsubscribe']) {
      expect(skipReason(button(label), opts), label).toBe('looks destructive');
      expect(skipReason(button(label), { ...opts, unsafe: true }), label).toBeUndefined();
    }
    expect(skipReason(link('http://localhost:3000/account/logout'), opts)).toBe('looks destructive');
    expect(skipReason(button('Deleted items'), opts)).toBeUndefined();
  });

  it("doesn't submit forms unless allowed", () => {
    expect(skipReason(button('Save', true), opts)).toBe('submits a form');
    expect(skipReason(button('Save', true), { ...opts, submitForms: true })).toBeUndefined();
  });

  it('skips downloads', () => {
    expect(skipReason(link('http://localhost:3000/report.pdf'), opts)).toBe('a download');
  });
});

describe('parseOptions', () => {
  it('needs --authorized for anything not on this machine', () => {
    expect(parseOptions(['https://example.com'])).toMatchObject({ error: expect.stringMatching(/--authorized/) });
    expect(parseOptions(['https://example.com', '--authorized'])).toMatchObject({ startUrl: 'https://example.com/', allow: ['example.com'] });
    expect(parseOptions(['http://localhost:5299'])).toMatchObject({ allow: ['localhost:5299'] });
  });

  it('rejects bad input with a reason', () => {
    expect(parseOptions(['not a url'])).toMatchObject({ error: expect.stringMatching(/isn't a URL/) });
    expect(parseOptions(['file:///etc/passwd'])).toMatchObject({ error: expect.stringMatching(/http and https/) });
    expect(parseOptions(['http://localhost', '--fail-on', 'sometimes'])).toMatchObject({ error: expect.stringMatching(/--fail-on/) });
    expect(parseOptions(['http://localhost', '--actions', '0'])).toMatchObject({ error: expect.stringMatching(/--actions/) });
  });

  it('adds extra allowed hosts', () => {
    expect(parseOptions(['http://localhost:3000', '--allow', 'localhost:4000'])).toMatchObject({ allow: ['localhost:3000', 'localhost:4000'] });
  });
});

describe('Random', () => {
  it('repeats with the same seed', () => {
    const a = new Random(42);
    const b = new Random(42);
    expect(Array.from({ length: 20 }, () => a.next())).toEqual(Array.from({ length: 20 }, () => b.next()));
  });

  it('never picks a zero-weight item', () => {
    const rng = new Random(1);
    for (let i = 0; i < 200; i++) expect(rng.weighted(['a', 'b'], x => (x === 'a' ? 0 : 1))).toBe('b');
  });
});

describe('markers', () => {
  it('can be found again in what was typed', () => {
    expect(markersIn(`O'Brien ${marker(3)} and ${marker(12)}`)).toEqual([3, 12]);
    expect(markersIn('plain text')).toEqual([]);
  });
});

describe('reproTest', () => {
  it('replays the steps as Playwright code', () => {
    const finding: Finding = {
      id: 4, kind: 'html-injection', severity: 'high', title: 'Input comes back as HTML', detail: 'x', url: 'http://localhost/', seen: 1,
      steps: [
        { kind: 'goto', url: 'http://localhost/profile' },
        { kind: 'fill', url: 'http://localhost/profile', selector: '#name', label: 'textbox "Display name"', value: `O'Brien ${marker(1)}` },
        { kind: 'press', url: 'http://localhost/search', selector: 'form > input', label: 'textbox "Search"', value: 'a"b' },
      ],
    };
    const code = reproTest(finding);
    expect(code).toContain(`await page.goto("http://localhost/profile");`);
    expect(code).toContain(`await page.locator("#name").fill("O'Brien <gremlin-mark-1>gremlin</gremlin-mark-1>"); // textbox "Display name"`);
    expect(code).toContain(`await page.locator("form > input").fill("a\\"b");`);
    expect(code).toContain(`await page.locator("form > input").press('Enter');`);
  });
});

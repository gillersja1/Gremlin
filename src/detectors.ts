import path from 'node:path';
import type { BrowserContext, Page, Response } from 'playwright';
import { isAllowedUrl } from './actions.js';
import { markerTag } from './payloads.js';
import type { Finding, FindingKind, Options, Severity, Step } from './types.js';

/** Patterns that only show up when an error's insides reach the page. */
const LEAKS: { name: string; pattern: RegExp }[] = [
  { name: '.NET stack trace', pattern: /\bat [\w.`<>$]+\(.*\) in .+:line \d+/ },
  { name: 'JavaScript stack trace', pattern: /^\s*at \S+ \((?:\/|[A-Za-z]:\\|file:|https?:).+:\d+:\d+\)\s*$/m },
  { name: 'Python traceback', pattern: /Traceback \(most recent call last\)/ },
  { name: 'Java stack trace', pattern: /^\s*at [\w.$]+\([\w]+\.java:\d+\)\s*$/m },
  { name: 'SQL error', pattern: /SQLSTATE\[|ORA-\d{5}|syntax error at or near "|You have an error in your SQL syntax|unterminated quoted string/i },
  { name: 'PHP error', pattern: /(Fatal error|Warning|Notice|Parse error): .+ on line \d+/ },
];

// Runs in the page after each step: what the gremlin can read off the page itself.
const SCAN = String.raw`((tags) => ({
  injected: tags.filter(t => document.getElementsByTagName(t).length > 0),
  text: (document.body && document.body.innerText || '').slice(0, 200000),
  overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
}))`;

export class Detectors {
  private readonly findings = new Map<string, Finding>();
  private readonly markerSteps = new Map<number, Step>();
  private readonly checkedHeaders = new Set<string>();
  /** Findings that still need their steps: those come once the action that surfaced them is recorded. */
  private fresh: Finding[] = [];
  private nextId = 1;
  private shots = 0;

  constructor(private readonly opts: Options, private readonly shotDir: string) {}

  /**
   * Gives findings that came up since the last call the steps that led to them: the trail since the last
   * direct navigation, up to and including the action just recorded.
   */
  attachSteps(trail: Step[]) {
    for (const finding of this.fresh) finding.steps = [...trail];
    this.fresh = [];
  }

  /** Remembers which step typed which marker, so a reflection can be traced back to its field. */
  typedMarkers(numbers: number[], step: Step) {
    for (const n of numbers) this.markerSteps.set(n, step);
  }

  list(): Finding[] {
    return [...this.findings.values()].sort((a, b) => a.id - b.id);
  }

  watch(context: BrowserContext) {
    for (const page of context.pages()) this.watchPage(page);
    context.on('page', page => this.watchPage(page));
  }

  private watchPage(page: Page) {
    page.on('pageerror', error => {
      this.add(page, 'page-error', 'medium', 'Uncaught error in the page', firstLine(error.message), `page-error:${firstLine(error.message)}`);
    });
    page.on('console', message => {
      if (message.type() !== 'error') return;
      const text = firstLine(message.text());
      // Failed loads are reported with their status code by the response watcher instead.
      if (/^Failed to load resource/.test(text)) return;
      this.add(page, 'console-error', 'low', 'Error logged to the console', text, `console:${text}`);
    });
    page.on('response', response => this.onResponse(page, response));
    page.on('requestfailed', request => {
      const error = request.failure()?.errorText ?? 'failed';
      // Requests cut off by a navigation aren't failures.
      if (/ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i.test(error) || !isAllowedUrl(request.url(), this.opts.allow)) return;
      this.add(page, 'request-failed', 'medium', 'A request failed', `${error}: ${request.url()}`, `failed:${request.url()}`);
    });
  }

  private onResponse(page: Page, response: Response) {
    const url = response.url();
    const status = response.status();
    if (page.url().startsWith('https:') && url.startsWith('http:')) {
      this.add(page, 'mixed-content', 'medium', 'Insecure content on a secure page', url, `mixed:${url}`);
    }
    if (!isAllowedUrl(url, this.opts.allow)) return;
    if (status >= 500) {
      this.add(page, 'server-error', 'high', `Server error ${status}`, `${response.request().method()} ${url}`, `5xx:${status}:${pathOf(url)}`);
    } else if (status === 404 || status === 410) {
      this.add(page, 'broken-link', 'medium', `Not found (${status})`, url, `404:${pathOf(url)}`);
    }
    if (response.request().isNavigationRequest() && response.frame() === page.mainFrame() && status < 400) {
      this.checkHeaders(page, response);
    }
  }

  private checkHeaders(page: Page, response: Response) {
    const url = new URL(response.url());
    const headers = response.headers();
    const csp = headers['content-security-policy'] ?? '';
    const missing: [string, string][] = [];
    if (!csp) missing.push(['content-security-policy', 'No Content-Security-Policy: the browser has no second line of defence if something injects a script.']);
    if ((headers['x-content-type-options'] ?? '').toLowerCase() !== 'nosniff') {
      missing.push(['x-content-type-options', 'No "X-Content-Type-Options: nosniff": browsers may guess content types, which can turn an upload into a script.']);
    }
    if (!headers['x-frame-options'] && !/frame-ancestors/i.test(csp)) {
      missing.push(['frame-protection', 'Neither X-Frame-Options nor a CSP frame-ancestors rule: other sites can frame these pages (clickjacking).']);
    }
    if (url.protocol === 'https:' && !headers['strict-transport-security']) {
      missing.push(['strict-transport-security', 'No Strict-Transport-Security: a first visit over plain http can be intercepted.']);
    }
    for (const [header, detail] of missing) {
      // Once per host: it's a server setting, not a per-page bug.
      const key = `header:${url.host}:${header}`;
      if (this.checkedHeaders.has(key)) continue;
      this.checkedHeaders.add(key);
      this.add(page, 'missing-header', 'low', `Missing security header: ${header}`, detail, key, { screenshot: false });
    }
  }

  /** Looks at the page after a step: markers that came back as HTML, leaked errors, sideways scrolling. */
  async scan(page: Page) {
    if (!isAllowedUrl(page.url(), this.opts.allow)) return;
    let seen: { injected: string[]; text: string; overflow: number };
    try {
      seen = (await page.evaluate(`${SCAN}(${JSON.stringify([...this.markerSteps.keys()].map(markerTag))})`)) as typeof seen;
    } catch {
      return; // Navigated mid-scan; the next step will look again.
    }
    for (const tag of seen.injected) {
      const n = Number(tag.split('-').pop());
      const typed = this.markerSteps.get(n);
      const where = typed?.label ? ` typed into ${typed.label} on ${typed.url}` : '';
      await this.add(page, 'html-injection', 'high', 'Input comes back as HTML',
        `The marker <${tag}>${where} appeared on this page as a real element, not as text. Input is reaching the page's HTML unescaped; a script tag would run the same way (cross-site scripting).`,
        // One finding per field and page it shows up on, however many markers go through it.
        `inject:${typed ? `${pathOf(typed.url)}|${typed.selector}` : n}->${pathOf(page.url())}`);
    }
    for (const leak of LEAKS) {
      const match = leak.pattern.exec(seen.text);
      if (match) {
        // A little context before the match, starting at a word boundary.
        let at = Math.max(0, match.index - 80);
        while (at > 0 && !/\s/.test(seen.text[at - 1])) at--;
        await this.add(page, 'error-leak', 'high', `Error details shown to the user (${leak.name})`,
          seen.text.slice(at, match.index + match[0].length + 120).replace(/\s+/g, ' ').trim(), `leak:${leak.name}:${pathOf(page.url())}`);
      }
    }
    if (seen.overflow > 2) {
      await this.add(page, 'layout-overflow', 'low', 'The page scrolls sideways',
        `Content is ${seen.overflow}px wider than the window.`, `overflow:${pathOf(page.url())}`);
    }
  }

  /** Cookies are checked once, at the end, for everything the run collected. */
  async checkCookies(context: BrowserContext, page: Page) {
    for (const cookie of await context.cookies()) {
      const host = cookie.domain.replace(/^\./, '');
      const allowed = this.opts.allow.some(a => a.split(':')[0] === host || a.split(':')[0].endsWith(`.${host}`));
      if (!allowed) continue;
      const problems: string[] = [];
      if (!cookie.httpOnly && /sess|auth|token|jwt|sid|login|identity/i.test(cookie.name)) problems.push('not HttpOnly, so scripts can read it');
      if (!cookie.secure && this.opts.startUrl.startsWith('https:')) problems.push('not Secure, so it can travel over plain http');
      if (cookie.sameSite === 'None' && !cookie.secure) problems.push('SameSite=None without Secure, which browsers reject');
      if (problems.length) {
        await this.add(page, 'insecure-cookie', 'medium', `Cookie "${cookie.name}" is unprotected`, problems.join('; '),
          `cookie:${cookie.name}`, { screenshot: false });
      }
    }
  }

  private async add(page: Page, kind: FindingKind, severity: Severity, title: string, detail: string, key: string,
    { screenshot = true }: { screenshot?: boolean } = {}) {
    const existing = this.findings.get(key);
    if (existing) {
      existing.seen++;
      return;
    }
    const finding: Finding = {
      id: this.nextId++, kind, severity, title, detail, url: page.url(), steps: [], seen: 1,
    };
    this.findings.set(key, finding);
    this.fresh.push(finding);
    if (screenshot && this.shots < 50) {
      const file = path.join(this.shotDir, `finding-${finding.id}.png`);
      try {
        await page.screenshot({ path: file, timeout: 5000 });
        finding.screenshot = file;
        this.shots++;
      } catch {
        // The page was closing or navigating; the steps still reproduce it.
      }
    }
  }
}

function firstLine(text: string): string {
  return text.split('\n')[0].slice(0, 300);
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return url;
  }
}

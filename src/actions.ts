import type { Page } from 'playwright';
import type { Random } from './random.js';
import type { Options, Step } from './types.js';
import { valueFor } from './payloads.js';

/** Something on the page the gremlin could interact with. */
export interface Candidate {
  selector: string;
  role: 'link' | 'button' | 'textbox' | 'checkbox' | 'radio' | 'combobox';
  label: string;
  /** Input type for textboxes, e.g. "email". */
  type: string;
  href?: string;
  /** Opens in a new tab. */
  newTab?: boolean;
  /** A button that would submit a form. */
  submits: boolean;
  options?: string[];
}

// Runs in the page. A plain string: the TypeScript loader can add helpers to compiled functions that
// don't exist in the browser.
const DISCOVER = String.raw`(() => {
  const MAX = 300;
  const cssPath = (el) => {
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node !== el && node.id && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1) {
        parts.unshift('#' + CSS.escape(node.id));
        break;
      }
      const tag = node.localName;
      const parent = node.parentElement;
      const same = parent ? [...parent.children].filter(c => c.localName === tag) : [node];
      parts.unshift(same.length > 1 ? tag + ':nth-of-type(' + (same.indexOf(node) + 1) + ')' : tag);
      node = parent;
    }
    return parts.join(' > ');
  };
  const text = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const labelOf = (el) =>
    text(el.getAttribute('aria-label')) ||
    text(el.labels && el.labels[0] && el.labels[0].innerText) ||
    text(el.innerText) || text(el.getAttribute('placeholder')) || text(el.getAttribute('title')) ||
    text(el.getAttribute('name')) || text(el.value) || el.localName;
  const visible = (el) => {
    if (el.disabled || el.readOnly) return false;
    if (el.checkVisibility && !el.checkVisibility()) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const TEXTLIKE = ['text', 'search', 'email', 'url', 'tel', 'number', 'password', 'date', 'range', ''];
  const found = [];
  for (const el of document.querySelectorAll('a[href], button, input, textarea, select, [role=button], [role=link]')) {
    if (found.length >= MAX) break;
    if (!visible(el)) continue;
    const tag = el.localName;
    const type = (el.getAttribute('type') || '').toLowerCase();
    const form = el.form || el.closest('form');
    let role, submits = false, href, newTab, options;
    if (tag === 'a' || el.getAttribute('role') === 'link') {
      role = 'link';
      href = el.href;
      newTab = el.target === '_blank';
    } else if (tag === 'select') {
      role = 'combobox';
      options = [...el.options].filter(o => !o.disabled).map(o => o.value);
    } else if (tag === 'textarea' || (tag === 'input' && TEXTLIKE.includes(type))) {
      role = 'textbox';
    } else if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
      role = type;
    } else if (tag === 'input' && ['hidden', 'file', 'image', 'color'].includes(type)) {
      continue;
    } else {
      role = 'button';
      submits = !!form && (tag === 'button' ? (type === '' || type === 'submit') : type === 'submit');
    }
    found.push({ selector: cssPath(el), role, label: labelOf(el), type: tag === 'textarea' ? 'textarea' : type, href, newTab, submits, options });
  }
  return found;
})()`;

/** Words on things a gremlin shouldn't press unless told it may: they can lose data, money or the session. */
const DANGER = /\b(delete|remove|destroy|erase|purge|pay|payment|purchase|buy|checkout|place order|order now|subscribe|unsubscribe|log ?out|sign ?out|deactivate|close (my )?account|reset|transfer|send money|donate|uninstall|revoke)\b/i;

const DOWNLOADS = /\.(zip|pdf|exe|msi|dmg|tar|gz|7z|iso|docx?|xlsx?|pptx?|csv|mp4|mov)(\?|#|$)/i;

export function isAllowedUrl(url: string, allow: string[]): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && allow.includes(u.host);
  } catch {
    return false;
  }
}

/** Why the gremlin won't touch a candidate, or undefined if it may. */
export function skipReason(c: Candidate, opts: Pick<Options, 'allow' | 'submitForms' | 'unsafe'>): string | undefined {
  if (c.role === 'link') {
    if (!c.href) return 'no address';
    if (!isAllowedUrl(c.href, opts.allow)) return 'leaves the allowed hosts';
    if (DOWNLOADS.test(c.href)) return 'a download';
  }
  if (!opts.unsafe && (DANGER.test(c.label) || (c.href !== undefined && DANGER.test(decodeURIComponent(c.href))))) {
    return 'looks destructive';
  }
  if (c.submits && !opts.submitForms) return 'submits a form';
  return undefined;
}

export async function discover(page: Page): Promise<Candidate[]> {
  try {
    return (await page.evaluate(DISCOVER)) as Candidate[];
  } catch {
    // The page navigated mid-look; try again next turn.
    return [];
  }
}

/** Picks what to do next: links to new pages and fields are the most interesting. */
export function choose(candidates: Candidate[], visited: Set<string>, rng: Random): Candidate {
  return rng.weighted(candidates, c => {
    switch (c.role) {
      case 'link':
        return visited.has(stripHash(c.href!)) ? 1 : 5;
      case 'textbox':
        return 3;
      case 'button':
        return c.submits ? 2 : 2.5;
      default:
        return 1;
    }
  });
}

export function stripHash(url: string): string {
  const u = new URL(url);
  u.hash = '';
  return u.href;
}

const TIMEOUT = 3000;

/** Does it, and says what it did. Returns undefined if the element couldn't be used after all. */
export async function perform(page: Page, c: Candidate, rng: Random, opts: Options, nextMarker: () => number): Promise<Step | undefined> {
  const url = page.url();
  const loc = page.locator(c.selector).first();
  const label = `${c.role} "${c.label}"`;
  try {
    switch (c.role) {
      case 'link':
        if (c.newTab) {
          // Follow it here rather than juggle tabs; the page it opens is what matters.
          await page.goto(c.href!, { timeout: 15_000 });
          return { kind: 'goto', url: c.href! };
        }
        await loc.click({ timeout: TIMEOUT });
        return { kind: 'click', url, selector: c.selector, label };
      case 'button':
        await loc.click({ timeout: TIMEOUT });
        return { kind: 'click', url, selector: c.selector, label };
      case 'checkbox':
      case 'radio':
        await loc.click({ timeout: TIMEOUT });
        return { kind: 'check', url, selector: c.selector, label };
      case 'combobox': {
        if (!c.options?.length) return undefined;
        const value = rng.pick(c.options);
        await loc.selectOption(value, { timeout: TIMEOUT });
        return { kind: 'select', url, selector: c.selector, label, value };
      }
      case 'textbox': {
        const value = valueFor(c.type, rng, nextMarker);
        await loc.fill(value, { timeout: TIMEOUT });
        if (opts.submitForms && rng.chance(0.3)) {
          await loc.press('Enter', { timeout: TIMEOUT });
          return { kind: 'press', url, selector: c.selector, label, value };
        }
        return { kind: 'fill', url, selector: c.selector, label, value };
      }
    }
  } catch {
    // Covered, detached or not editable after all: not a bug in itself, so move on.
    return undefined;
  }
}

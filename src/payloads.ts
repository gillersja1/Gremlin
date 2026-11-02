import type { Random } from './random.js';

// What the gremlin types into fields. These are the inputs real users send by accident: long text,
// apostrophes, emoji, odd numbers. The one HTML-shaped value is a harmless made-up tag: if it comes back
// as a real element, the page is putting input into its HTML unescaped. No scripts, no attack payloads.

/** The tag name for marker number n. Custom elements need a dash; nothing on a real page uses this one. */
export function markerTag(n: number): string {
  return `gremlin-mark-${n}`;
}

export function marker(n: number): string {
  const tag = markerTag(n);
  return `<${tag}>gremlin</${tag}>`;
}

/** Finds the marker numbers inside a value the gremlin typed, if any. */
export function markersIn(value: string): number[] {
  return [...value.matchAll(/<gremlin-mark-(\d+)>/g)].map(m => Number(m[1]));
}

const TEXT = [
  "O'Brien",
  'Zoë Ångström-Nuñez',
  '名前 テスト',
  '😈🔥 gremlin was here',
  '   leading and trailing spaces   ',
  '',
  'a',
  'Robert"); --',
  '%s %n %x {0} ${name}',
  'null',
  'undefined',
  '../../../etc/passwd',
];

const NUMBERS = ['0', '-1', '1.5', '99999999999999999999', '1e309', 'NaN', '٣', ' 42 '];

const EMAILS = ['gremlin@example.com', "o'brien+test@example.co.uk", 'not-an-email', '@example.com', 'a@b'];

/** A value for a field, chosen to suit its type. Every few text values carry a marker. */
export function valueFor(type: string, rng: Random, nextMarker: () => number): string {
  switch (type) {
    case 'number':
    case 'range':
      return rng.pick(NUMBERS);
    case 'email':
      return rng.pick(EMAILS);
    case 'tel':
      return rng.pick(['+1 555 0100', '0', 'phone', '+'.repeat(30)]);
    case 'url':
      return rng.pick(['https://example.com', 'javascript:void(0)', 'not a url', 'http://']);
    case 'date':
      return rng.pick(['2026-02-30', '1900-01-01', '9999-12-31', '']);
    case 'password':
      return rng.pick(['correct horse battery staple', '', "pa'ss\"word"]);
    default: {
      const roll = rng.next();
      if (roll < 0.35) return `${rng.pick(["O'Brien ", 'Zoë ', ''])}${marker(nextMarker())}`;
      if (roll < 0.45) return 'gremlin '.repeat(rng.pick([64, 700]));
      return rng.pick(TEXT);
    }
  }
}

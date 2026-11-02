#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { explore } from './explore.js';
import { summary, writeReport } from './report.js';
import { SEVERITY_ORDER, type Options, type Severity } from './types.js';

const USAGE = `gremlin: let a gremlin loose on a web app you own, and see what breaks

Usage:
  gremlin <url> [options]

Options:
  --actions <n>      How many things to try (default: 200)
  --minutes <n>      Stop after this long, whichever comes first (default: 5)
  --seed <n>         Repeat a run exactly (default: random; the report says which was used)
  --allow <host>     Another host it may visit, e.g. api.example.com:8443 (repeatable)
  --submit-forms     Submit forms and press Enter in fields. This can create or change data.
  --unsafe           Also click things labelled delete, pay, log out and the like.
  --mobile           Explore on a phone-sized screen
  --headed           Watch it in a visible browser
  --out <dir>        Where to write the report (default: gremlin-report)
  --fail-on <level>  Exit with code 1 if anything this severe is found: high, medium, low or never (default: high)
  --authorized       Required for anything other than localhost: you confirm you own the site
                     or have written permission to test it.
  -h, --help         Show this help
`;

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

export function parseOptions(argv: string[]): Options | { error: string } | 'help' {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      actions: { type: 'string', default: '200' },
      minutes: { type: 'string', default: '5' },
      seed: { type: 'string' },
      allow: { type: 'string', multiple: true, default: [] },
      'submit-forms': { type: 'boolean', default: false },
      unsafe: { type: 'boolean', default: false },
      mobile: { type: 'boolean', default: false },
      headed: { type: 'boolean', default: false },
      out: { type: 'string', default: 'gremlin-report' },
      'fail-on': { type: 'string', default: 'high' },
      authorized: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) return 'help';
  const [start] = positionals;
  if (!start) return { error: 'Give the gremlin a URL to start from.' };

  let url: URL;
  try {
    url = new URL(start);
  } catch {
    return { error: `"${start}" isn't a URL. Include the scheme, e.g. http://localhost:3000.` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'Only http and https sites can be explored.' };
  if (!LOCAL.has(url.hostname) && !values.authorized) {
    return {
      error: `${url.host} isn't on this machine. Only run the gremlin against sites you own or have written ` +
        'permission to test: it clicks, types and probes like an attacker would. If you do, add --authorized.',
    };
  }

  const num = (name: string, value: string | undefined, min: number) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= min ? n : undefined;
  };
  const actions = num('actions', values.actions, 1);
  const minutes = num('minutes', values.minutes, 0.1);
  if (actions === undefined) return { error: '--actions must be a whole number of at least 1.' };
  if (minutes === undefined) return { error: '--minutes must be a number of at least 0.1.' };
  const seed = values.seed === undefined ? Math.floor(Math.random() * 2 ** 31) : Number(values.seed);
  if (!Number.isInteger(seed)) return { error: '--seed must be a whole number.' };
  const failOn = values['fail-on'] as string;
  if (failOn !== 'never' && !SEVERITY_ORDER.includes(failOn as Severity)) return { error: '--fail-on must be high, medium, low or never.' };

  return {
    startUrl: url.href,
    allow: [url.host, ...(values.allow as string[])],
    maxActions: Math.floor(actions),
    maxMinutes: minutes,
    seed,
    submitForms: values['submit-forms'] as boolean,
    unsafe: values.unsafe as boolean,
    mobile: values.mobile as boolean,
    headed: values.headed as boolean,
    outDir: values.out as string,
    failOn: failOn as Severity | 'never',
  };
}

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseOptions(argv);
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (parsed === 'help') {
    console.log(USAGE);
    return 0;
  }
  if ('error' in parsed) {
    console.error(parsed.error);
    return 2;
  }
  const opts = parsed;
  console.log(`Releasing the gremlin on ${opts.startUrl} (seed ${opts.seed}, up to ${opts.maxActions} actions)`);
  console.log(`  Allowed hosts: ${opts.allow.join(', ')}${opts.submitForms ? '; submitting forms' : ''}${opts.unsafe ? '; UNSAFE: clicking destructive-looking controls' : ''}`);

  const result = await explore(opts, message => console.log(message));
  const report = await writeReport(result, opts);
  console.log(`\n${summary(result)}`);
  console.log(`\nReport: ${path.relative(process.cwd(), report)}`);
  console.log(`Trace:  npx playwright show-trace ${path.relative(process.cwd(), result.trace)}`);

  if (opts.failOn === 'never') return 0;
  const threshold = SEVERITY_ORDER.indexOf(opts.failOn);
  return result.findings.some(f => SEVERITY_ORDER.indexOf(f.severity) <= threshold) ? 1 : 0;
}

// Only run when called as a program, so tests can import parseOptions.
if (process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then(
    code => { process.exitCode = code; },
    error => {
      console.error(error instanceof Error ? error.stack : error);
      process.exitCode = 2;
    },
  );
}

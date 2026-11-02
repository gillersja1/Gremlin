import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, devices, type Page } from 'playwright';
import { choose, discover, isAllowedUrl, perform, skipReason, stripHash } from './actions.js';
import { Detectors } from './detectors.js';
import { markersIn } from './payloads.js';
import { Random } from './random.js';
import type { Finding, Options, Step } from './types.js';

export interface RunResult {
  findings: Finding[];
  actions: number;
  pagesVisited: string[];
  skipped: Record<string, number>;
  durationMs: number;
  trace: string;
}

const MAX_TRAIL = 40;

/** Lets the gremlin loose on the start URL and reports what it found. */
export async function explore(opts: Options, log: (message: string) => void = () => {}): Promise<RunResult> {
  const outDir = path.resolve(opts.outDir);
  const shotDir = path.join(outDir, 'screenshots');
  await mkdir(shotDir, { recursive: true });

  const rng = new Random(opts.seed);
  const detectors = new Detectors(opts, shotDir);
  const browser = await chromium.launch({ headless: !opts.headed });
  const context = await browser.newContext({
    ...(opts.mobile ? devices['iPhone 13'] : { viewport: { width: 1280, height: 800 } }),
    acceptDownloads: false,
    // Leave dialogs to the gremlin's own handler below.
    ignoreHTTPSErrors: false,
  });
  await context.tracing.start({ screenshots: true, snapshots: true });
  detectors.watch(context);

  const page = await context.newPage();
  // alert(), confirm() and friends would stop everything; dismiss them and carry on.
  page.on('dialog', dialog => dialog.dismiss().catch(() => {}));

  const started = Date.now();
  const deadline = started + opts.maxMinutes * 60_000;
  const visited = new Set<string>();
  const skipped: Record<string, number> = {};
  let trail: Step[] = [];
  let markerCount = 0;
  const nextMarker = () => ++markerCount;
  let actions = 0;

  const goto = async (url: string) => {
    try {
      await page.goto(url, { timeout: 30_000 });
    } catch (error) {
      log(`  couldn't load ${url}: ${(error as Error).message.split('\n')[0]}`);
    }
    trail = [{ kind: 'goto', url }];
    await settle(page);
    detectors.attachSteps(trail);
    await detectors.scan(page);
    detectors.attachSteps(trail);
  };

  try {
    await goto(opts.startUrl);
    while (actions < opts.maxActions && Date.now() < deadline) {
      // Wandered off (a redirect, a closed tab)? Back to somewhere allowed.
      if (!isAllowedUrl(page.url(), opts.allow)) {
        await goto(visited.size ? rng.pick([...visited]) : opts.startUrl);
        continue;
      }
      visited.add(stripHash(page.url()));

      const usable = [];
      for (const candidate of await discover(page)) {
        const reason = skipReason(candidate, opts);
        if (reason) skipped[reason] = (skipped[reason] ?? 0) + 1;
        else usable.push(candidate);
      }

      // Nothing to do here, or now and then for variety: go somewhere else.
      if (usable.length === 0 || rng.chance(0.04)) {
        await goto(rng.pick([...visited]));
        actions++;
        continue;
      }

      const candidate = choose(usable, visited, rng);
      const step = await perform(page, candidate, rng, opts, nextMarker);
      actions++;
      if (!step) continue;
      if (step.value) detectors.typedMarkers(markersIn(step.value), step);

      if (step.kind === 'goto') trail = [step];
      else trail = [...trail, step].slice(-MAX_TRAIL);
      log(`  ${String(actions).padStart(4)}  ${describe(step)}`);

      // Close any tabs the step opened; their errors were already caught.
      for (const other of context.pages()) if (other !== page) await other.close().catch(() => {});
      await settle(page);
      detectors.attachSteps(trail);
      await detectors.scan(page);
      detectors.attachSteps(trail);
    }
    await detectors.checkCookies(context, page);
    detectors.attachSteps(trail);
  } finally {
    const trace = path.join(outDir, 'trace.zip');
    await context.tracing.stop({ path: trace }).catch(() => {});
    await browser.close();
  }

  return {
    findings: detectors.list(),
    actions,
    pagesVisited: [...visited],
    skipped,
    durationMs: Date.now() - started,
    trace: path.join(outDir, 'trace.zip'),
  };
}

/** Waits briefly for whatever the last step set off: a navigation, a fetch, a re-render. */
async function settle(page: Page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(150);
}

export function describe(step: Step): string {
  switch (step.kind) {
    case 'goto':
      return `go to ${step.url}`;
    case 'fill':
      return `type ${JSON.stringify(shorten(step.value ?? ''))} into ${step.label}`;
    case 'press':
      return `type ${JSON.stringify(shorten(step.value ?? ''))} into ${step.label} and press Enter`;
    case 'select':
      return `choose ${JSON.stringify(step.value)} in ${step.label}`;
    case 'check':
      return `tick ${step.label}`;
    case 'back':
      return 'go back';
    default:
      return `click ${step.label}`;
  }
}

function shorten(text: string): string {
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

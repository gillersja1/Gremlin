import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, type RunResult } from './explore.js';
import { SEVERITY_ORDER, type Finding, type Options, type Step } from './types.js';

/** A Playwright test that replays the steps behind a finding. */
export function reproTest(finding: Finding): string {
  const lines = finding.steps.map(stepCode);
  return [
    "import { test } from '@playwright/test';",
    '',
    `// Gremlin finding ${finding.id} (${finding.severity}): ${finding.title}`,
    `// ${finding.detail.replace(/\s+/g, ' ').slice(0, 200)}`,
    `test(${JSON.stringify(`gremlin #${finding.id}: ${finding.title}`)}, async ({ page }) => {`,
    ...lines.map(line => `  ${line}`),
    '  // Now look for what the gremlin saw.',
    '});',
    '',
  ].join('\n');
}

function stepCode(step: Step): string {
  const loc = step.selector ? `page.locator(${JSON.stringify(step.selector)})` : '';
  const comment = step.label ? ` // ${step.label}` : '';
  switch (step.kind) {
    case 'goto':
      return `await page.goto(${JSON.stringify(step.url)});`;
    case 'fill':
      return `await ${loc}.fill(${JSON.stringify(step.value ?? '')});${comment}`;
    case 'press':
      return `await ${loc}.fill(${JSON.stringify(step.value ?? '')});${comment}\n  await ${loc}.press('Enter');`;
    case 'select':
      return `await ${loc}.selectOption(${JSON.stringify(step.value ?? '')});${comment}`;
    case 'back':
      return 'await page.goBack();';
    default:
      return `await ${loc}.click();${comment}`;
  }
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || a.id - b.id);
}

export function summary(result: RunResult): string {
  const counts = SEVERITY_ORDER.map(s => `${result.findings.filter(f => f.severity === s).length} ${s}`).join(', ');
  const lines = [
    `Gremlin took ${result.actions} actions across ${result.pagesVisited.length} pages in ${(result.durationMs / 1000).toFixed(0)}s.`,
    `Findings: ${result.findings.length} (${counts}).`,
  ];
  for (const f of sortFindings(result.findings)) {
    lines.push(`  [${f.severity.toUpperCase().padEnd(6)}] #${f.id} ${f.title}${f.seen > 1 ? ` (x${f.seen})` : ''}`);
    lines.push(`           ${f.detail.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  const skips = Object.entries(result.skipped);
  if (skips.length) lines.push(`Left alone: ${skips.map(([why, n]) => `${n} ${why}`).join(', ')}.`);
  return lines.join('\n');
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** A preview of the page when it happened, cropped to its top; the link opens the full screenshot. */
const shot = (src: string) => `<a href="${src}"><img src="${src}" alt="The page when it happened (click for full size)" loading="lazy"></a>`;

function html(result: RunResult, opts: Options, outDir: string): string {
  const rows = sortFindings(result.findings).map(f => `
    <article class="finding ${f.severity}">
      <h2><span class="sev">${f.severity}</span> #${f.id} ${escapeHtml(f.title)}${f.seen > 1 ? ` <small>seen ${f.seen} times</small>` : ''}</h2>
      <p>${escapeHtml(f.detail)}</p>
      <p class="where">On <a href="${escapeHtml(f.url)}">${escapeHtml(f.url)}</a></p>
      ${f.screenshot ? shot(escapeHtml(path.relative(outDir, f.screenshot).replace(/\\/g, '/'))) : ''}
      <details><summary>Steps (${f.steps.length})</summary><ol>${f.steps.map(s => `<li>${escapeHtml(describe(s))}</li>`).join('')}</ol></details>
      <details><summary>Playwright test to reproduce it</summary><pre>${escapeHtml(reproTest(f))}</pre></details>
    </article>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Gremlin report: ${escapeHtml(opts.startUrl)}</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 980px; padding: 24px; color: #1d1d1f; }
  .finding { border: 1px solid #ddd; border-left-width: 6px; border-radius: 8px; padding: 12px 16px; margin: 14px 0; }
  .finding.high { border-left-color: #d93025; } .finding.medium { border-left-color: #f29900; } .finding.low { border-left-color: #8ab4f8; }
  .sev { text-transform: uppercase; font-size: 12px; letter-spacing: .08em; }
  h2 { font-size: 17px; margin: 0 0 6px; } small { font-weight: normal; color: #666; }
  img { display: block; width: 100%; height: 240px; object-fit: cover; object-position: top left; border: 1px solid #ddd; border-radius: 4px; margin: 6px 0; }
  pre { background: #f6f8fa; padding: 10px; overflow: auto; font-size: 13px; }
  .where { color: #555; font-size: 13px; word-break: break-all; }
</style></head><body>
<h1>Gremlin report</h1>
<p>${escapeHtml(summary(result).split('\n').slice(0, 2).join(' '))}</p>
<p>Started at ${escapeHtml(opts.startUrl)} with seed ${opts.seed}. Replay this run with <code>--seed ${opts.seed}</code>.
Full trace: <code>npx playwright show-trace ${escapeHtml(path.relative(process.cwd(), result.trace))}</code></p>
${rows || '<p>Nothing found. The gremlin is disappointed.</p>'}
</body></html>`;
}

/** Writes report.json, report.html and one repro test per finding. Returns the HTML report's path. */
export async function writeReport(result: RunResult, opts: Options): Promise<string> {
  const outDir = path.resolve(opts.outDir);
  const reproDir = path.join(outDir, 'repro');
  await mkdir(reproDir, { recursive: true });
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify({ options: opts, ...result }, null, 2));
  for (const f of result.findings) {
    await writeFile(path.join(reproDir, `finding-${f.id}.spec.ts`), reproTest(f));
  }
  const report = path.join(outDir, 'report.html');
  await writeFile(report, html(result, opts, outDir));
  return report;
}

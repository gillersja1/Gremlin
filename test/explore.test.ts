import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { explore, type RunResult } from '../src/explore.js';
import { writeReport } from '../src/report.js';
import type { Options } from '../src/types.js';
import { startBuggySite, type BuggySite } from './fixtures/buggy-site.js';

let site: BuggySite;
let outDir: string;
let result: RunResult;
let opts: Options;

beforeAll(async () => {
  site = await startBuggySite();
  outDir = await mkdtemp(path.join(os.tmpdir(), 'gremlin-'));
  opts = {
    startUrl: site.url,
    allow: [new URL(site.url).host],
    maxActions: 150,
    maxMinutes: 3,
    seed: 7,
    submitForms: true,
    unsafe: false,
    mobile: false,
    headed: false,
    outDir,
    failOn: 'high',
  };
  result = await explore(opts);
}, 240_000);

afterAll(async () => {
  await site?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

const kinds = () => new Set(result.findings.map(f => f.kind));

describe('a run on the buggy site', () => {
  it('finds the planted bugs', () => {
    expect([...kinds()].sort()).toEqual(expect.arrayContaining([
      'broken-link', 'error-leak', 'html-injection', 'insecure-cookie', 'missing-header', 'page-error', 'server-error',
    ]));
  });

  it('traces an injection back to the field it was typed into', () => {
    const injections = result.findings.filter(f => f.kind === 'html-injection');
    expect(injections.length).toBeGreaterThan(0);
    for (const finding of injections) {
      expect(finding.detail).toMatch(/typed into textbox "(Display name|Search)"/);
      expect(finding.steps.some(s => s.value?.includes('<gremlin-mark-'))).toBe(true);
    }
  });

  it('leaves destructive controls and other sites alone', () => {
    expect(site.hits.get('/admin/delete-everything') ?? 0).toBe(0);
    expect(result.pagesVisited.every(url => url.startsWith(site.url))).toBe(true);
    expect(result.skipped['looks destructive']).toBeGreaterThan(0);
    expect(result.skipped['leaves the allowed hosts']).toBeGreaterThan(0);
  });

  it('reports an injection once per field, however many markers go through it', () => {
    const injections = result.findings.filter(f => f.kind === 'html-injection');
    const fields = injections.map(f => /typed into (textbox "[^"]+" on \S+)/.exec(f.detail)![1] + ' -> ' + f.url);
    expect(new Set(fields).size).toBe(fields.length);
  });

  it('reports each problem once, counting repeats', () => {
    const headerFindings = result.findings.filter(f => f.kind === 'missing-header');
    expect(new Set(headerFindings.map(f => f.title)).size).toBe(headerFindings.length);
  });

  it('writes a report with a repro test for every finding', async () => {
    const report = await writeReport(result, opts);
    const html = await readFile(report, 'utf8');
    // The report must not fall for the gremlin's own markers.
    expect(html).not.toMatch(/<gremlin-mark-\d+>/);
    expect(html).toContain('&lt;gremlin-mark-');
    for (const finding of result.findings) {
      const repro = await readFile(path.join(outDir, 'repro', `finding-${finding.id}.spec.ts`), 'utf8');
      expect(repro).toContain(`gremlin #${finding.id}`);
    }
    const json = JSON.parse(await readFile(path.join(outDir, 'report.json'), 'utf8'));
    expect(json.findings).toHaveLength(result.findings.length);
  });
});

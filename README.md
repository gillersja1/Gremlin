# Gremlin

Turn a gremlin loose on your web app. It explores with [Playwright](https://playwright.dev) like a curious,
slightly malicious user: following links, typing odd things into fields, ticking boxes and picking options.
Then it tells you what broke. Every finding comes with the steps that led to it, a screenshot, a full
Playwright trace, and a ready-to-run Playwright test that reproduces it.

> **Only point Gremlin at sites you own or have written permission to test.** It behaves like an attacker
> poking at forms. It refuses anything other than localhost unless you pass `--authorized`.

## What it finds

| Severity | Finding |
| --- | --- |
| High | **Input comes back as HTML**: text it typed reappears as real markup (a sign of cross-site scripting) |
| High | **Server errors** (HTTP 5xx) |
| High | **Error details shown to users**: stack traces, SQL errors, PHP warnings |
| Medium | Uncaught JavaScript errors, broken links (404/410), failed requests, insecure content on https pages, unprotected session cookies |
| Low | Errors logged to the console, missing security headers (CSP, nosniff, anti-framing, HSTS), pages that scroll sideways |

It finds the warning signs without exploiting them. The only HTML it types is a harmless made-up tag,
`<gremlin-mark-N>`: if that comes back as a real element, input is reaching the page unescaped, and a
`<script>` would too. Everything else is what real users type by accident: apostrophes, emoji, very long
text, odd numbers and dates.

## Quick start

```bash
npm install
npx playwright install chromium
npx tsx src/cli.ts http://localhost:3000
```

Open `gremlin-report/report.html` for the findings. Each has a test in `gremlin-report/repro/`, and the
whole run is in `gremlin-report/trace.zip` (`npx playwright show-trace gremlin-report/trace.zip`).

## Guardrails

- **Stays on your site.** It only visits the start URL's host, plus any you add with `--allow`.
  Everything else is skipped, including downloads.
- **Careful by default.** It won't submit forms or press Enter in fields unless you pass `--submit-forms`,
  because submitting can create or change data. Point it at a local or staging copy when you do.
- **Leaves destructive controls alone.** It won't click anything labelled delete, remove, pay, buy,
  checkout, log out, unsubscribe, reset and the like, unless you pass `--unsafe`.
- **Dismisses dialogs** so an `alert()` can't stall it.
- **Repeatable.** Runs are seeded; the report gives the seed, and `--seed` replays the same choices.

## Options

```text
gremlin <url> [options]

  --actions <n>      How many things to try (default: 200)
  --minutes <n>      Stop after this long, whichever comes first (default: 5)
  --seed <n>         Repeat a run exactly
  --allow <host>     Another host it may visit (repeatable)
  --submit-forms     Submit forms and press Enter in fields
  --unsafe           Also click destructive-looking controls
  --mobile           Explore on a phone-sized screen
  --headed           Watch it in a visible browser
  --out <dir>        Where to write the report (default: gremlin-report)
  --fail-on <level>  Exit 1 if anything this severe is found: high, medium, low or never (default: high)
  --authorized       Required for anything other than localhost
```

`--fail-on` makes it a CI check: run your app, release the gremlin, and fail the build on high findings.

## First catch

Its first outing outside the test suite was against [Playwright Dungeon Crawl](https://github.com/gillersja1/PlaywrightDungeonCrawl-Starter),
running locally: 250 actions over 40 pages, forms included, with no injections, crashes or leaks. It did
find that the dungeon sends no Content-Security-Policy, X-Content-Type-Options or anti-framing headers.

## Development

```bash
npm test          # unit tests, plus a full run against a deliberately buggy local site
npm run typecheck
npm run build     # compiles the CLI to dist/
```

The buggy site in `test/fixtures/` has one of each problem planted on purpose, and a "Delete everything"
link the gremlin must never follow.

## License

MIT

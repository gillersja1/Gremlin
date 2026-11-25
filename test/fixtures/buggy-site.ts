// A small site with bugs planted on purpose, for the gremlin to find. Never deploy this anywhere.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface BuggySite {
  url: string;
  /** How many times each path was requested. */
  hits: Map<string, number>;
  close(): Promise<void>;
}

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>
<body><nav><a href="/">Home</a> <a href="/search">Search</a> <a href="/profile">Profile</a> <a href="/about">About</a></nav>
<h1>${title}</h1>${body}</body></html>`;

const membersPage = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>
<body><nav><a href="/members">Members</a> <a href="/members/vault">The vault</a> <a href="/members/sign-out">Sign out</a></nav>
<h1>${title}</h1>${body}</body></html>`;

export async function startBuggySite(): Promise<BuggySite> {
  const hits = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);
    const send = (status: number, html: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(html);
    };

    // A members' area, not linked from the public pages, behind a sign-in cookie.
    const member = /(?:^|;\s*)member=yes(?:;|$)/.test(req.headers.cookie ?? '');
    if (url.pathname === '/login') {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          const form = new URLSearchParams(body);
          if (form.get('user') === 'gremlin' && form.get('password') === 'letmein') {
            res.writeHead(303, { location: '/members', 'set-cookie': 'member=yes; Path=/; HttpOnly; SameSite=Lax' });
            res.end();
          } else {
            send(401, page('Sign in', '<p>Wrong name or password.</p>'));
          }
        });
        return;
      }
      return send(200, page('Sign in', `
        <form method="post" action="/login"><label>User <input name="user"></label>
        <label>Password <input name="password" type="password"></label><button>Sign in</button></form>`));
    }
    if (url.pathname.startsWith('/members')) {
      if (!member) {
        res.writeHead(302, { location: '/login' });
        return res.end();
      }
      switch (url.pathname) {
        case '/members':
          return send(200, membersPage('Members', '<p>Welcome back.</p>'));
        case '/members/vault':
          // Bug: a members-only page whose script throws.
          return send(200, membersPage('Vault', '<p>Treasure.</p><script>vaultTreasure.count()</script>'));
        case '/members/sign-out':
          return send(200, page('Signed out', '<p>Bye.</p>'), { 'set-cookie': 'member=; Path=/; Max-Age=0' });
        case '/members/expire':
          // The session ends by itself, as one would when it times out.
          return send(200, membersPage('Members', '<p>Your session has ended.</p>'), { 'set-cookie': 'member=; Path=/; Max-Age=0' });
      }
    }

    switch (url.pathname) {
      case '/':
        // Bug: a session cookie scripts can read.
        return send(200, page('Buggy Shop', `
          <p><a href="/crash">Order history</a> · <a href="/gone">Old catalogue</a> · <a href="/wide">Big table</a></p>
          <p><a href="/admin/delete-everything">Delete everything</a> · <a href="https://example.com/">Our partners</a></p>
          <button id="oops" type="button" onclick="undefinedFunction()">Surprise me</button>`), { 'set-cookie': 'session=abc123; Path=/' });
      case '/search': {
        // Bug: the search term goes back into the page unescaped.
        const q = url.searchParams.get('q');
        return send(200, page('Search', `
          <form action="/search"><label>Search <input name="q"></label><button>Go</button></form>
          ${q !== null ? `<p>Results for ${q}</p>` : ''}`));
      }
      case '/profile':
        // Bug: a live preview that writes input in as HTML, no submit needed.
        return send(200, page('Profile', `
          <label>Display name <input id="name"></label>
          <p>Preview: <span id="preview"></span></p>
          <script>document.getElementById('name').addEventListener('input', e => {
            document.getElementById('preview').innerHTML = e.target.value;
          });</script>`));
      case '/about':
        return send(200, page('About', '<p>A perfectly normal page.</p>'));
      case '/crash':
        // Bugs: a 500, with the stack trace shown to the user.
        return send(500, page('Error', `<pre>System.NullReferenceException: Object reference not set to an instance of an object.
   at BuggyShop.Orders.History(Int32 customerId) in C:\\src\\BuggyShop\\Orders.cs:line 42
   at BuggyShop.Program.Main() in C:\\src\\BuggyShop\\Program.cs:line 7</pre>`));
      case '/wide':
        return send(200, page('Big table', '<div style="width: 3000px">A very wide table</div>'));
      case '/admin/delete-everything':
        // The gremlin must never come here unless told it may.
        return send(200, page('Deleted', '<p>Everything is gone.</p>'));
      default:
        return send(404, page('Not found', '<p>Nothing here.</p>'));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    hits,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

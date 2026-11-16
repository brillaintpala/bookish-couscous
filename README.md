# Bookish Proxy Browser

A small, Render-hostable reverse-proxy browser. The server fetches HTTP/HTTPS pages, rewrites common page/resource URLs so they continue through the proxy, and lets the user's browser render the returned HTML. It does **not** launch Chromium, Puppeteer, or a per-user browser container.

## Deploy to Render

1. Push this repository to GitHub (the Render Blueprint is render.yaml in the repository root).
2. In Render, choose **New → Blueprint**, connect brillaintpala/bookish-couscous, and select the main branch.
3. When prompted, provide a long random value for PROXY_ACCESS_KEY. Keep it private.
4. Apply the Blueprint and wait for the first deploy to finish.
5. Open the service URL. Enter the same value in the **Proxy key** field, then enter a website address.

The service configuration explicitly defines:

- Runtime: Node
- Build command: npm install --omit=dev
- Start command: npm start
- Health check: /health
- Plan: free
- Region: Singapore

There is no frontend build step, no static publish directory, and no browser binary to install. Render supplies PORT; the server binds to 0.0.0.0.

## Run locally

Requires Node.js 20.18.1 or newer.

~~~sh
npm install
PROXY_ACCESS_KEY="choose-a-long-random-secret" npm start
~~~

Open http://localhost:10000, enter the same key, and browse to an HTTP or HTTPS URL.

## How it works

- A normal Node HTTP server accepts page and asset requests.
- HTML links, forms, media references, srcset, CSS url() and @import, and redirects are rewritten to the proxy endpoint.
- A small in-page bridge maps common fetch, XHR, EventSource, and navigation-history URLs back through the proxy.
- Upstream cookies are namespaced by target hostname so cookies for separate sites do not collide in the proxy's browser origin.
- Binary files and other non-HTML responses are streamed. Small HTML/CSS responses are rewritten in memory; larger ones are streamed without rewriting.
- Private, local, and reserved IP ranges are blocked to reduce server-side request forgery (SSRF) risk.
- When PROXY_ACCESS_KEY is set, every proxy request must include the key. The browser keeps it in session storage for the current tab and carries it through rewritten page requests.

## Known limitations

This is a practical HTTP reverse proxy, **not a full browser engine**. No proxy can promise that every website will render without errors. Some sites depend on WebSockets, service workers, browser-specific APIs, persistent local storage, WebAuthn/passkeys, complex cross-origin behavior, native DRM, or bot/CAPTCHA checks. Those sites may be incomplete or refuse access. The proxy does not spoof browser fingerprints, rotate IP addresses, or bypass a site's access controls.

The proxy also adapts some upstream Content Security Policy directives and removes frame-blocking headers so proxied resources can load inside the isolated frame. This changes the upstream page's original security policy. Do not use it for banking, payments, private accounts, or other sensitive sessions.

## Render free-tier behavior

Render free web services spin down after 15 minutes without inbound traffic and may take about a minute to wake on the next request. Free services can restart, have an ephemeral filesystem, and share monthly instance-hour and outbound-bandwidth limits. This app does not store user data on disk, but in-memory DNS cache data is lost on restart. Heavy pages can consume the free service's CPU and outbound bandwidth quickly.

Check Render's current free-instance limits before public use:
https://render.com/docs/free


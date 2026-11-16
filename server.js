"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const dns = require("node:dns").promises;
const net = require("node:net");
const { once } = require("node:events");
const cheerio = require("cheerio");

const PORT = Number(process.env.PORT || 10000);
const ACCESS_KEY = process.env.PROXY_ACCESS_KEY || "";
const HOST = "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_REWRITE_BYTES = 6 * 1024 * 1024;
const DNS_CACHE_MS = 60_000;
const dnsCache = new Map();
const HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "proxy-connection"
]);
const URL_ATTRIBUTES = [
  "href", "src", "action", "formaction", "poster", "data", "cite",
  "background", "manifest", "xlink:href"
];

function hasValidAccessKey(value) {
  if (!ACCESS_KEY) return true;
  const supplied = Buffer.from(String(value || ""));
  const expected = Buffer.from(ACCESS_KEY);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function isBlockedIp(address) {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    const a = p[0], b = p[1], c = p[2];
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 2 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0 && c === 113);
  }
  if (net.isIPv6(ip)) {
    if (ip === "::" || ip === "::1" || ip.startsWith("fc") ||
        ip.startsWith("fd") || /^fe[89ab]/.test(ip) || ip.startsWith("ff")) return true;
    const mapped = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]);
  }
  return false;
}

async function validateTarget(value) {
  let target;
  try { target = new URL(value); } catch { throw new Error("Enter a valid website URL."); }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS websites are supported.");
  }
  if (target.username || target.password) throw new Error("URLs containing credentials are not allowed.");

  const hostname = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") || hostname.endsWith(".internal") ||
      hostname === "metadata.google.internal") {
    throw new Error("That host is not available through this proxy.");
  }

  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) throw new Error("Private and local network addresses are blocked.");
  } else {
    let addresses = dnsCache.get(hostname);
    if (!addresses || addresses.expires < Date.now()) {
      const result = await dns.lookup(hostname, { all: true, verbatim: true });
      addresses = { values: result.map(item => item.address), expires: Date.now() + DNS_CACHE_MS };
      dnsCache.set(hostname, addresses);
      if (dnsCache.size > 500) {
        for (const [key, item] of dnsCache) if (item.expires < Date.now()) dnsCache.delete(key);
      }
    }
    if (!addresses.values.length || addresses.values.some(isBlockedIp)) {
      throw new Error("The website resolves to a private or reserved network address.");
    }
  }

  target.hash = "";
  return target;
}

function cookiePrefix(hostname) {
  return "__pb_" + Buffer.from(hostname.toLowerCase()).toString("base64url").slice(0, 32) + "_";
}

function cookiesForTarget(cookieHeader, hostname) {
  const prefix = cookiePrefix(hostname);
  if (!cookieHeader) return "";
  return cookieHeader.split(";").map(part => part.trim()).filter(Boolean).map(part => {
    const split = part.indexOf("=");
    if (split < 1) return "";
    const name = part.slice(0, split);
    if (!name.startsWith(prefix)) return "";
    return name.slice(prefix.length) + part.slice(split);
  }).filter(Boolean).join("; ");
}

function rewriteSetCookie(cookie, hostname) {
  const parts = cookie.split(";").map(part => part.trim());
  const first = parts.shift() || "";
  const split = first.indexOf("=");
  if (split < 1) return null;
  const name = first.slice(0, split);
  const value = first.slice(split + 1);
  const attrs = parts.filter(part => !/^domain=/i.test(part) && !/^path=/i.test(part));
  attrs.push("Path=/");
  return cookiePrefix(hostname) + name + "=" + value + "; " + attrs.join("; ");
}

function sourceUrlFromReferer(referer) {
  if (!referer) return null;
  try {
    const ref = new URL(referer);
    if (ref.pathname !== "/proxy") return null;
    const raw = ref.searchParams.get("url");
    return raw ? new URL(raw) : null;
  } catch { return null; }
}

function proxyPath(value, base, accessKey) {
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith("#") || /^(?:data|blob|javascript|mailto|tel|sms|about):/i.test(raw)) return raw;
  try {
    const resolved = new URL(raw, base);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return raw;
    return "/proxy?url=" + encodeURIComponent(resolved.href) + (accessKey ? "&key=" + encodeURIComponent(accessKey) : "");
  } catch { return raw; }
}

function rewriteCss(css, base, accessKey) {
  return css
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, quote, value) =>
      "url(" + quote + proxyPath(value, base, accessKey) + quote + ")")
    .replace(/@import\s+(['"])(.*?)\1/gi, (match, quote, value) =>
      "@import " + quote + proxyPath(value, base) + quote);
}

function rewriteHtml(html, target, accessKey) {
  const $ = cheerio.load(html, { decodeEntities: false });
  let pageBase = target;
  const originalBase = $("base[href]").first().attr("href");
  if (originalBase) {
    try { pageBase = new URL(originalBase, target); } catch {}
  }
  $("base").remove();

  for (const attr of URL_ATTRIBUTES) {
    $("[" + attr + "]").each((_, element) => {
      const current = $(element).attr(attr);
      if (current) $(element).attr(attr, proxyPath(current, pageBase, accessKey));
    });
  }

  $("[srcset]").each((_, element) => {
    const value = $(element).attr("srcset");
    if (!value) return;
    const rewritten = value.split(",").map(candidate => {
      const trimmed = candidate.trim();
      const match = trimmed.match(/^(\S+)([\s\S]*)$/);
      return match ? proxyPath(match[1], pageBase) + match[2] : trimmed;
    }).join(", ");
    $(element).attr("srcset", rewritten);
  });

  $("[style]").each((_, element) => {
    $(element).attr("style", rewriteCss($(element).attr("style"), pageBase, accessKey));
  });
  $("style").each((_, element) => {
    $(element).text(rewriteCss($(element).text(), pageBase, accessKey));
  });

  $("meta[http-equiv]").each((_, element) => {
    if (String($(element).attr("http-equiv")).toLowerCase() !== "refresh") return;
    const value = $(element).attr("content") || "";
    $(element).attr("content", value.replace(/url\s*=\s*(['"]?)([^'";]+)\1/i,
      (match, quote, url) => "url=" + quote + proxyPath(url.trim(), pageBase, accessKey) + quote));
  });

  if (!$("head").length) $("html").prepend("<head></head>");
  const bridge = $("<script></script>")
    .attr("src", "/bridge.js?base=" + encodeURIComponent(pageBase.href) + (accessKey ? "&key=" + encodeURIComponent(accessKey) : ""));
  $("head").prepend(bridge);
  return $.html();
}

function relaxProxyCsp(policy) {
  const extra = {
    "script-src": ["https:", "http:", "'unsafe-inline'", "'unsafe-eval'"],
    "style-src": ["https:", "http:", "'unsafe-inline'"],
    "img-src": ["https:", "http:", "data:", "blob:"],
    "font-src": ["https:", "http:", "data:"],
    "connect-src": ["https:", "http:", "wss:", "ws:"],
    "media-src": ["https:", "http:", "data:", "blob:"],
    "frame-src": ["https:", "http:", "data:", "blob:"],
    "worker-src": ["https:", "http:", "blob:"]
  };
  const directives = new Map();
  for (const part of String(policy).split(";")) {
    const bits = part.trim().split(/\s+/).filter(Boolean);
    if (!bits.length || bits[0].toLowerCase() === "frame-ancestors") continue;
    directives.set(bits.shift().toLowerCase(), bits);
  }
  for (const [name, values] of Object.entries(extra)) {
    const current = directives.get(name) || [];
    directives.set(name, Array.from(new Set(current.concat(values))));
  }
  return Array.from(directives, ([name, values]) => name + (values.length ? " " + values.join(" ") : "")).join("; ");
}

function corsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin === "null" || origin === "http://" + req.headers.host ||
      origin === "https://" + req.headers.host) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers",
    req.headers["access-control-request-headers"] || "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, Content-Length, Content-Range, Accept-Ranges");
}

function sendText(res, status, message) {
  const body = Buffer.from(String(message));
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-store" });
  res.end(body);
}

function copyResponseHeaders(req, upstream, target, accessKey) {
  const headers = {};
  upstream.headers.forEach((value, name) => {
    const key = name.toLowerCase();
    if (HOP_HEADERS.has(key) || key === "content-length" || key === "content-encoding" ||
        key === "set-cookie" || key === "location" || key === "x-frame-options") return;
    if (key === "content-security-policy") headers[name] = relaxProxyCsp(value);
    else headers[name] = value;
  });

  const cookies = typeof upstream.headers.getSetCookie === "function"
    ? upstream.headers.getSetCookie()
    : (upstream.headers.get("set-cookie") ? [upstream.headers.get("set-cookie")] : []);
  const mapped = cookies.map(cookie => rewriteSetCookie(cookie, target.hostname)).filter(Boolean);
  if (mapped.length) headers["set-cookie"] = mapped;

  const location = upstream.headers.get("location");
  if (location) {
    try { headers.location = proxyPath(location, target, accessKey); } catch { headers.location = location; }
  }
  corsHeaders(req, { setHeader: (name, value) => { headers[name] = value; } });
  return headers;
}

async function pumpLimited(body, limit, res) {
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) return Buffer.concat(chunks, size);
    const chunk = Buffer.from(item.value);
    chunks.push(chunk);
    size += chunk.length;
    if (size > limit) {
      for (const part of chunks) {
        if (!res.write(part)) await once(res, "drain");
      }
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (!res.write(Buffer.from(next.value))) await once(res, "drain");
      }
      res.end();
      return null;
    }
  }
}

async function handleProxy(req, res, incomingUrl) {
  const accessKey = incomingUrl.searchParams.get("key") || "";
  if (!hasValidAccessKey(accessKey)) return sendText(res, 401, "Proxy key required. Enter the configured key in the browser toolbar.");
  const rawTarget = incomingUrl.searchParams.get("url");
  if (!rawTarget || rawTarget.length > 8192) return sendText(res, 400, "Missing or invalid ?url= website address.");
  let target;
  try { target = await validateTarget(rawTarget); }
  catch (error) { return sendText(res, 400, error.message); }

  if (req.method === "OPTIONS") {
    corsHeaders(req, res);
    res.writeHead(204);
    return res.end();
  }

  const source = sourceUrlFromReferer(req.headers.referer);
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const key = name.toLowerCase();
    if (HOP_HEADERS.has(key) || key === "host" || key === "content-length" ||
        key === "accept-encoding" || key === "cookie" || key === "origin" ||
        key === "referer" || key === "sec-fetch-site") continue;
    if (value !== undefined) headers[key] = value;
  }

  const scopedCookies = cookiesForTarget(req.headers.cookie, target.hostname);
  if (scopedCookies) headers.cookie = scopedCookies;
  if (source) {
    headers.referer = source.href;
    headers.origin = source.origin;
    headers["sec-fetch-site"] = source.origin === target.origin ? "same-origin" : "cross-site";
  }

  const options = {
    method: req.method,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(60_000)
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    options.body = req;
    options.duplex = "half";
  }

  let upstream;
  try {
    upstream = await fetch(target, options);
  } catch (error) {
    return sendText(res, 502, "Upstream request failed: " + (error.cause?.message || error.message));
  }

  const responseHeaders = copyResponseHeaders(req, upstream, target, accessKey);
  res.writeHead(upstream.status, responseHeaders);

  if (req.method === "HEAD" || !upstream.body) return res.end();

  const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
  const shouldRewriteHtml = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
  const shouldRewriteCss = contentType.includes("text/css");

  if (shouldRewriteHtml || shouldRewriteCss) {
    try {
      const body = await pumpLimited(upstream.body, MAX_REWRITE_BYTES, res);
      if (body === null) return;
      const text = body.toString("utf8");
      const output = shouldRewriteHtml ? rewriteHtml(text, target, accessKey) : rewriteCss(text, target, accessKey);
      res.end(Buffer.from(output));
      return;
    } catch (error) {
      if (!res.headersSent) return sendText(res, 502, "Could not process upstream response.");
      return res.destroy(error);
    }
  }

  try {
    const { Readable } = require("node:stream");
    for await (const chunk of Readable.fromWeb(upstream.body)) {
      if (!res.write(chunk)) await once(res, "drain");
    }
    res.end();
  } catch (error) {
    if (!res.destroyed) res.destroy(error);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, "http://" + (req.headers.host || "localhost"));

    if (requestUrl.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ ok: true, service: "bookish-couscous-proxy-browser" }));
    }

    if (requestUrl.pathname === "/bridge.js") {
      const script = fs.readFileSync(path.join(PUBLIC_DIR, "bridge.js"));
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      return res.end(script);
    }

    if (requestUrl.pathname === "/proxy") {
      corsHeaders(req, res);
      return await handleProxy(req, res, requestUrl);
    }

    if (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html") {
      const page = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"));
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin"
      });
      return res.end(page);
    }

    sendText(res, 404, "Not found.");
  } catch (error) {
    if (!res.headersSent) sendText(res, 500, "Server error.");
    else if (!res.destroyed) res.destroy(error);
    console.error(error);
  }
});

server.headersTimeout = 65_000;
server.requestTimeout = 65_000;
server.keepAliveTimeout = 5_000;
server.listen(PORT, HOST, () => {
  console.log("Proxy browser listening on " + HOST + ":" + PORT);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));

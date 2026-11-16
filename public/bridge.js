(() => {
  "use strict";
  const script = document.currentScript;
  let currentBase;
  try {
    currentBase = new URL(new URL(script.src).searchParams.get("base"));
  } catch {
    return;
  }

  const proxyPrefix = "/proxy?url=";
  const proxify = (value) => {
    const raw = value instanceof URL ? value.href : String(value || "").trim();
    if (!raw || raw.startsWith("#") || raw.startsWith(proxyPrefix) ||
        /^(?:data|blob|javascript|mailto|tel|sms|about):/i.test(raw)) return raw;
    try {
      const absolute = new URL(raw, currentBase);
      if (absolute.protocol !== "http:" && absolute.protocol !== "https:") return raw;
      return proxyPrefix + encodeURIComponent(absolute.href);
    } catch {
      return raw;
    }
  };

  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    try {
      if (input instanceof Request) {
        const mapped = new Request(proxify(input.url), input);
        const credentialed = new Request(mapped, { credentials: "include" });
        return originalFetch(credentialed, init);
      }
      const options = Object.assign({}, init || {});
      if (!options.credentials || options.credentials === "same-origin") {
        options.credentials = "include";
      }
      return originalFetch(proxify(input), options);
    } catch {
      return originalFetch(input, init);
    }
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    try { url = proxify(url); } catch {}
    return originalOpen.call(this, method, url, ...rest);
  };
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(...args) {
    try { this.withCredentials = true; } catch {}
    return originalSend.apply(this, args);
  };

  if (window.EventSource) {
    const NativeEventSource = window.EventSource;
    window.EventSource = function(url, options) {
      return new NativeEventSource(proxify(url), options);
    };
    window.EventSource.prototype = NativeEventSource.prototype;
    Object.setPrototypeOf(window.EventSource, NativeEventSource);
  }

  if (navigator.sendBeacon) {
    const originalBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => originalBeacon(proxify(url), data);
  }

  const originalOpenWindow = window.open;
  window.open = (url, ...rest) => originalOpenWindow.call(window, proxify(url), ...rest);

  for (const method of ["pushState", "replaceState"]) {
    const original = history[method].bind(history);
    history[method] = (state, title, url) => {
      if (url != null) {
        try {
          const absolute = new URL(url, currentBase);
          currentBase = absolute;
          url = proxify(absolute.href);
        } catch {}
      }
      return original(state, title, url);
    };
  }

  const urlAttributes = ["href", "src", "action", "formaction", "poster", "data", "cite", "background"];
  const rewriteElement = (element) => {
    if (!(element instanceof Element)) return;
    for (const name of urlAttributes) {
      if (element.hasAttribute(name)) {
        const old = element.getAttribute(name);
        const next = proxify(old);
        if (next !== old) element.setAttribute(name, next);
      }
    }
    if (element.hasAttribute("srcset")) {
      const old = element.getAttribute("srcset");
      const next = old.split(",").map(candidate => {
        const trimmed = candidate.trim();
        const match = trimmed.match(/^(\S+)([\s\S]*)$/);
        return match ? proxify(match[1]) + match[2] : trimmed;
      }).join(", ");
      if (next !== old) element.setAttribute("srcset", next);
    }
  };

  const rewriteTree = (node) => {
    if (node instanceof Element) rewriteElement(node);
    if (node.querySelectorAll) node.querySelectorAll("*").forEach(rewriteElement);
  };
  rewriteTree(document.documentElement);

  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === "attributes") rewriteElement(record.target);
      else for (const node of record.addedNodes) rewriteTree(node);
    }
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: urlAttributes.concat(["srcset"])
  });
})();

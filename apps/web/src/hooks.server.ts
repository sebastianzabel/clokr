import type { Handle, HandleServerError } from "@sveltejs/kit";

const API_BACKEND = process.env.API_URL || "http://localhost:4000";
const LOG_LEVEL = process.env.LOG_LEVEL || "info"; // debug | info | warn | error

function log(level: string, msg: string, data?: Record<string, unknown>) {
  const entry = {
    level,
    time: new Date().toISOString(),
    service: "clokr-web",
    msg,
    ...data,
  };
  console.log(JSON.stringify(entry));
}

export const handle: Handle = async ({ event, resolve }) => {
  const start = Date.now();

  // Proxy /api requests to the backend API server
  if (event.url.pathname.startsWith("/api")) {
    try {
      const targetUrl = `${API_BACKEND}${event.url.pathname}${event.url.search}`;
      const response = await fetch(targetUrl, {
        method: event.request.method,
        headers: event.request.headers,
        body:
          event.request.method !== "GET" && event.request.method !== "HEAD"
            ? await event.request.arrayBuffer()
            : undefined,
        // @ts-expect-error -- duplex needed for streaming request bodies
        duplex: "half",
      });

      if (LOG_LEVEL === "debug") {
        log("debug", "api proxy", {
          method: event.request.method,
          url: event.url.pathname,
          status: response.status,
          duration: Date.now() - start,
        });
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (err) {
      log("error", "API proxy error", {
        url: event.url.pathname,
        error: err instanceof Error ? err.message : String(err),
      });
      return new Response(JSON.stringify({ error: "API nicht erreichbar" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // SSR page requests
  const response = await resolve(event);

  if (LOG_LEVEL === "debug" || (response.status >= 400 && LOG_LEVEL !== "error")) {
    log(response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "info", "request", {
      method: event.request.method,
      url: event.url.pathname,
      status: response.status,
      duration: Date.now() - start,
    });
  }

  return response;
};

export const handleError: HandleServerError = ({ error, event }) => {
  const err = error instanceof Error ? error : new Error(String(error));

  log("error", "SSR error", {
    url: event.url.pathname,
    message: err.message,
    stack: err.stack,
  });

  return {
    message: "Ein Fehler ist aufgetreten",
  };
};

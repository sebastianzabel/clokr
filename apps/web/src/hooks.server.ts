import type { Handle } from "@sveltejs/kit";

const API_BACKEND = process.env.API_URL || "http://localhost:4000";

export const handle: Handle = async ({ event, resolve }) => {
  // Proxy /api requests to the backend API server
  if (event.url.pathname.startsWith("/api")) {
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
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  return resolve(event);
};

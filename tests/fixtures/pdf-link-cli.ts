globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  if (String(url) === "https://example.com/content" && init?.method === "HEAD")
    return new Response(null, { headers: { "content-type": "application/pdf" } });
  if (String(url) === "https://example.com/article" && init?.method === "GET")
    return new Response("<head><title>Resolved paper title</title></head>", { headers: { "content-type": "text/html" } });
  throw new Error("Unexpected request in PDF CLI fixture");
}) as typeof fetch;

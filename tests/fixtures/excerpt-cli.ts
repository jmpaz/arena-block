globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  if (String(url) === "https://example.com/article" && init?.method === "GET") return new Response('<title>Page title</title><p>First words, a <b>complete</b> middle and last words.</p>', { headers: { "content-type": "text/html" } });
  throw new Error("Unexpected request in excerpt CLI fixture");
}) as typeof fetch;

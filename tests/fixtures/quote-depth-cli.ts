const fixtureTweets = new Map(Array.from({ length: 4 }, (_, index) => {
  const id = 100 - index;
  return [String(id), { id: String(id), author: { screen_name: `author${id}` }, text: `Exact source ${id}.`,
    created_at: id === 100 ? "Tue Oct 06 16:12:20 +0000 2026" : "Wed Mar 18 12:00:00 +0000 2026",
    media: { all: [{ type: "photo", url: `https://example.com/${id}.jpg`, width: 640, height: 480 }] },
    ...(index === 3 ? {} : { quote: { id: String(id - 1), author: { screen_name: `author${id - 1}` }, text: "Observed embedded source" } }) }];
}));
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (!url.startsWith("https://api.fxtwitter.com/")) throw new Error("Unexpected fixture request");
  const tweet = fixtureTweets.get(url.split("/").at(-1)!);
  if (!tweet) throw new Error("Unexpected source request before policy validation");
  return Response.json({ tweet });
}, { preconnect: originalFetch.preconnect });

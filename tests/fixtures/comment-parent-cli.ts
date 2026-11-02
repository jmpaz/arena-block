const original = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
  const match = /\/item\/(\d+)\.json$/.exec(String(input));
  if (!match) throw new Error("Unexpected source request");
  const id = Number(match[1]);
  return Response.json(id === 1 ? { id, type: "story", title: "Story" } : { id, type: "comment", parent: id-1, by: `user${id}`, text: `Body ${id}`, time: 1704067200 });
}, { preconnect: original.preconnect });

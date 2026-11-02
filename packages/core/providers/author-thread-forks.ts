function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function observedAuthorForks(raw: unknown, did: string): Set<string> {
  const forks = new Set<string>(), seen = new Set<unknown>();
  const pending: unknown[] = [record(raw)?.thread];
  while (pending.length) {
    const value = pending.pop();
    if (seen.has(value)) continue;
    seen.add(value);
    const node = record(value), post = record(node?.post);
    if (!node || !post) continue;
    const replies: unknown[] = Array.isArray(node.replies) ? node.replies : [];
    pending.push(...replies);
    if (record(post.author)?.did !== did || typeof post.uri !== "string" || typeof post.cid !== "string" || !post.cid) continue;
    const prefix = post.uri.slice(0, post.uri.lastIndexOf("/") + 1);
    if (!prefix.startsWith(`at://${did}/`)) continue;
    const children = new Set<string>();
    for (const reply of replies) {
      const child = record(record(reply)?.post), parent = record(record(record(child?.record)?.reply)?.parent);
      if (record(child?.author)?.did === did && typeof child?.uri === "string" && child.uri.startsWith(prefix)
        && typeof child.cid === "string" && child.cid && parent?.uri === post.uri && parent.cid === post.cid) children.add(child.uri);
    }
    if (children.size > 1) forks.add(post.uri);
  }
  return forks;
}

export function assertNoKnownAuthorForks(uris: string[], seed: string, forks: Set<string>): void {
  const index = uris.indexOf(seed);
  if (index >= 0 && uris.slice(index).some(uri => forks.has(uri))) {
    throw new Error("Bluesky thread forks into multiple author replies; choose posts explicitly");
  }
}

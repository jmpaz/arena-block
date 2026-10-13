export type ChannelRow = {
  id: number;
  title: string;
  slug: string;
  visibility: "private" | "closed" | "public";
  owner: { name: string; slug: string };
  count?: number;
  canAdd?: boolean;
};
export type ChannelChoice = { value: string; title: string; id?: number };
export type ChannelScope = "my" | "following" | "all";

function object(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

export function channelPage(raw: unknown, page: number): { rows: ChannelRow[]; nextPage: number | null; accountId?: number } {
  const data = object(raw);
  const entries = data.channels ?? data.data;
  if (!Array.isArray(entries) || entries.length > 30) throw new Error("Are.na returned an invalid channel page.");
  const rows: ChannelRow[] = [];
  for (const entry of entries) {
    const item = object(entry), owner = object(item.owner), counts = object(item.counts), can = object(item.can);
    if (!Number.isSafeInteger(item.id) || item.id < 1 || typeof item.title !== "string"
      || typeof item.slug !== "string" || typeof owner.name !== "string" || typeof owner.slug !== "string") continue;
    rows.push({ id: item.id, title: item.title, slug: item.slug,
      visibility: item.visibility === "private" ? "private" : item.visibility === "closed" ? "closed" : "public",
      owner: { name: owner.name, slug: owner.slug },
      ...(Number.isSafeInteger(item.count) && item.count >= 0 ? { count: item.count }
        : Number.isSafeInteger(counts.contents) && counts.contents >= 0 ? { count: counts.contents } : {}),
      ...(typeof item.canAdd === "boolean" ? { canAdd: item.canAdd }
        : typeof can.add_to === "boolean" ? { canAdd: can.add_to } : {}),
    });
  }
  const meta = object(data.meta);
  const candidate = data.nextPage ?? meta.next_page;
  const nextPage = Number.isSafeInteger(candidate) && candidate > page && candidate <= 100 ? candidate
    : meta.has_more_pages === true && page < 100 ? page + 1 : null;
  return { rows, nextPage, ...(Number.isSafeInteger(data.accountId) ? { accountId: data.accountId } : {}) };
}

export function channelValue(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(trimmed)) throw new Error("Enter a channel slug or ID.");
  return trimmed;
}

function normalized(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
function words(value: string): string[] { return normalized(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean); }
function matchesWord(needle: string, field: string): boolean {
  const value = normalized(field);
  if (value.includes(needle)) return true;
  for (const part of words(field)) {
    let index = 0;
    for (const character of part) if (character === needle[index]) index++;
    if (needle.length >= 3 && index === needle.length) return true;
  }
  return false;
}
export function matchesChannel(row: ChannelRow, query: string): boolean {
  return words(query).every(word => [row.title, row.slug, row.owner.name, row.owner.slug]
    .some(field => matchesWord(word, field)));
}

/** Stable insertion order: selecting and refreshing metadata never move a row. */
export class ChannelPickerModel {
  readonly selected = new Map<string, ChannelChoice>();
  readonly owned = new Map<number, ChannelRow>();
  readonly network = new Map<number, ChannelRow>();
  scope: ChannelScope = "my";
  query = "";
  nextPage: number | null = 1;
  accountId?: number;

  restore(values: unknown): void {
    if (!Array.isArray(values)) return;
    for (const value of values.slice(0, 20)) {
      const item = object(value);
      try {
        const chosen = channelValue(item.value);
        if (typeof item.title === "string") this.selected.set(chosen, { value: chosen, title: item.title,
          ...(Number.isSafeInteger(item.id) ? { id: item.id } : {}) });
      } catch { /* Ignore an invalid old draft entry. */ }
    }
  }

  choose(row: ChannelRow): void {
    const existing = [...this.selected.values()].find(item => item.id === row.id || item.value === row.slug);
    if (existing) { this.selected.delete(existing.value); return; }
    if (row.canAdd === false) throw new Error("This channel does not allow additions.");
    if (this.selected.size >= 20) throw new Error("Choose at most 20 channels.");
    const value = String(row.id);
    this.selected.set(value, { value, title: row.title, id: row.id });
  }

  add(value: string): void {
    const chosen = channelValue(value);
    if (this.selected.has(chosen)) return;
    if (this.selected.size >= 20) throw new Error("Choose at most 20 channels.");
    this.selected.set(chosen, { value: chosen, title: chosen });
  }

  remove(value: string): void { this.selected.delete(value); }

  replaceRows(rows: ChannelRow[], page: number, nextPage: number | null, accountId?: number): void {
    if (page === 1 && this.scope !== "my") this.network.clear();
    if (this.scope === "my" && accountId && this.accountId && accountId !== this.accountId) {
      this.owned.clear();
      this.selected.clear();
    }
    if (accountId) this.accountId = accountId;
    const target = this.scope === "my" ? this.owned : this.network;
    for (const row of rows) {
      target.set(row.id, row);
      const chosen = [...this.selected.values()].find(item => item.id === row.id || item.value === row.slug);
      if (chosen) this.selected.set(chosen.value, { ...chosen, title: row.title, id: row.id });
    }
    this.nextPage = nextPage;
  }

  rows(): ChannelRow[] {
    const target = this.scope === "my" ? this.owned : this.network;
    return [...target.values()].filter(row => this.scope !== "my" || matchesChannel(row, this.query));
  }
}

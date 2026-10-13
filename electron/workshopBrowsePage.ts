/** Per-item data Steam's browse page embeds as escaped JSON (rating, short description, popularity). */
export type PageItemInfo = { starRating?: number; totalVotes?: number; description?: string; subscriptions?: number; favorited?: number };

/** Undo the page's double escaping (JSON inside a JS string). */
function decodeEscaped(raw: string): string {
  try {
    const once = JSON.parse(`"${raw}"`) as string;
    try {
      return JSON.parse(`"${once}"`) as string;
    } catch {
      return once;
    }
  } catch {
    return raw;
  }
}

export function parseBrowsePageInfo(html: string): Map<string, PageItemInfo> {
  const out = new Map<string, PageItemInfo>();
  const marker = /\\"publishedfileid\\":\\"(\d+)\\"/g;
  const hits = [...html.matchAll(marker)];
  for (let i = 0; i < hits.length; i++) {
    const id = hits[i][1];
    if (out.has(id)) continue;
    const start = hits[i].index ?? 0;
    const end = i + 1 < hits.length ? (hits[i + 1].index ?? html.length) : Math.min(html.length, start + 20000);
    const seg = html.slice(start, end);
    const num = (key: string) => {
      const m = new RegExp(`\\\\"${key}\\\\":(\\d+)`).exec(seg);
      return m ? Number(m[1]) : undefined;
    };
    const desc = /\\"short_description\\":\\"([\s\S]*?)\\",\\"/.exec(seg)?.[1];
    out.set(id, {
      starRating: num('star_rating'),
      totalVotes: num('total_votes'),
      subscriptions: num('lifetime_subscriptions'),
      favorited: num('lifetime_favorited'),
      description: desc ? decodeEscaped(desc).replace(/\[\/?[a-z0-9*]+(=[^\]]*)?\]/gi, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim() : undefined,
    });
  }
  return out;
}

/** Steam's count of mods matching the query and its page count (from the results query embedded in the page). */
export function parseBrowseTotals(html: string): { total?: number; totalPages?: number } {
  const m = /\\"total_pages\\":(\d+),\\"total_count\\":(\d+),\\"results\\"/.exec(html);
  return m ? { totalPages: Number(m[1]), total: Number(m[2]) } : {};
}

/** The game's own Workshop tags (the first tag list in its Workshop config), admin-only tags left out. */
export function parseBrowseTags(html: string): string[] {
  const start = html.indexOf('\\"tags\\":[{');
  if (start < 0) return [];
  const end = html.indexOf(']', start);
  const seg = html.slice(start, end < 0 ? start + 20000 : end);
  const out: string[] = [];
  for (const m of seg.matchAll(/\\"name\\":\\"(.*?)\\",\\"display_name\\":\\".*?\\",\\"admin_only\\":(true|false)/g)) {
    if (m[2] === 'true') continue;
    const name = decodeEscaped(m[1]);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

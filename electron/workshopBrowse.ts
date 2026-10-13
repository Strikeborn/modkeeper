import type { WorkshopBrowseItem, WorkshopBrowseQuery, WorkshopBrowseResult } from '../shared/types';
import { fetchWorkshopDetails, type WorkshopFetchProgress } from './workshopApi';
import { workshopUnsupportedMessage } from './workshopSupport';
import { formatCreatorDisplay, resolveSteamCreatorNames, steamProfileUrl } from './steamCreators';
import { splitWorkshopTags } from './workshopTags';
import { parseBrowsePageInfo, parseBrowseTags, parseBrowseTotals } from './workshopBrowsePage';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function sortParam(sort: WorkshopBrowseQuery['sort']): string {
  switch (sort) {
    case 'recent':
      return 'mostrecent';
    case 'updated':
      return 'lastupdated';
    case 'subscribed':
      // Steam dropped "mostsubscribed" (it quietly falls back to trending)
      return 'totaluniquesubscribers';
    case 'rated':
      return 'toprated';
    default:
      return 'trend';
  }
}

export function buildBrowseUrl(q: WorkshopBrowseQuery, now = Date.now()): string {
  const params = new URLSearchParams();
  params.set('appid', String(q.appId));
  params.set('browsesort', sortParam(q.sort));
  params.set('actualsort', sortParam(q.sort));
  params.set('section', 'readytouseitems');
  const days = q.periodDays && q.periodDays > 0 ? Math.round(q.periodDays) : 0;
  if (days) {
    // made within the period, whatever the sort; trending also ranks over the same window
    const end = Math.floor(now / 1000);
    params.set('created_date_range_filter_start', String(end - days * 86400));
    params.set('created_date_range_filter_end', String(end));
    if (sortParam(q.sort) === 'trend') params.set('days', String(days));
  }
  params.set('p', String(q.page ?? 1));
  params.set('numperpage', String(q.numPerPage ?? 30));
  if (q.searchText?.trim()) params.set('searchtext', q.searchText.trim());
  if (q.categoryTag?.trim()) params.set('requiredtags[]', q.categoryTag.trim());
  return `https://steamcommunity.com/workshop/browse/?${params.toString()}`;
}

/** Steam's full description as plain text: BBCode and links out, trimmed to what a card can show. */
function cleanDescription(raw?: string): string | undefined {
  const t = raw
    ?.replace(/\[\/?[a-z0-9*]+(=[^\]]*)?\]/gi, ' ')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t ? t.slice(0, 700) : undefined;
}

const JUNK_TITLE_RE = /modding policy|workshop guidelines|welcome to .* workshop|how to install|spiffo'?s workshop/i;

function isJunkWorkshopItem(title: string, workshopId: string): boolean {
  if (JUNK_TITLE_RE.test(title)) return true;
  if (title.trim().toLowerCase() === 'modding policy') return true;
  return false;
}

function extractWorkshopIds(html: string, appId: number): string[] {
  const ids = new Set<string>();
  const scoped = html.includes(`appid=${appId}`) || html.includes(`"appid":${appId}`);
  for (const m of html.matchAll(/filedetails\/\?id=(\d+)/g)) {
    ids.add(m[1]);
  }
  if (!scoped && ids.size > 0) {
    return [];
  }
  return [...ids];
}

export async function queryWorkshopBrowse(
  q: WorkshopBrowseQuery,
  onProgress?: WorkshopFetchProgress,
): Promise<WorkshopBrowseResult> {
  const explicit = workshopUnsupportedMessage(q.appId);
  if (explicit && !q.searchText?.trim()) {
    return {
      items: [],
      page: q.page ?? 1,
      appId: q.appId,
      error: explicit,
      sourceUrl: buildBrowseUrl(q),
    };
  }

  const url = buildBrowseUrl(q);
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  const finalUrl = res.url;

  if (!res.ok) {
    return {
      items: [],
      page: q.page ?? 1,
      appId: q.appId,
      error: `Steam returned HTTP ${res.status}`,
      sourceUrl: url,
    };
  }

  const html = await res.text();
  const urlAppOk = finalUrl.includes(`appid=${q.appId}`) || finalUrl.includes(`app/${q.appId}`);
  if (!urlAppOk && !finalUrl.includes('workshop/browse')) {
    return {
      items: [],
      page: q.page ?? 1,
      appId: q.appId,
      error:
        explicit ??
        `This game does not expose a Steam Workshop browse page (app ${q.appId}). Use Nexus or All mods for local installs.`,
      sourceUrl: url,
    };
  }

  let ids = extractWorkshopIds(html, q.appId);
  const pageInfo = parseBrowsePageInfo(html);
  const totals = parseBrowseTotals(html);
  const tags = parseBrowseTags(html);

  if (ids.length === 0 && totals.total === 0) {
    // the filters (period, tag, search) match nothing: an empty page, not a broken Workshop
    return { items: [], page: q.page ?? 1, appId: q.appId, total: 0, totalPages: 0, tags, sourceUrl: url };
  }
  if (ids.length === 0) {
    return {
      items: [],
      page: q.page ?? 1,
      appId: q.appId,
      error:
        explicit ??
        'No Workshop items for this game on Steam (page empty or blocked). Try Browse Workshop (web) or another game.',
      sourceUrl: url,
    };
  }

  onProgress?.({ fetched: 0, total: ids.length, chunk: 1, chunkTotal: 1 });
  const details = await fetchWorkshopDetails(ids, onProgress);

  const filteredIds = ids.filter((id) => {
    const d = details.get(id);
    if (!d) return false;
    if (d.result != null && d.result !== 1) return false;
    if (d.consumer_app_id != null && d.consumer_app_id !== q.appId) return false;
    return true;
  });

  if (filteredIds.length === 0) {
    return {
      items: [],
      page: q.page ?? 1,
      appId: q.appId,
      error:
        explicit ??
        `Steam returned unrelated Workshop links (wrong app). ${q.appId} may not have a public Workshop catalog.`,
      sourceUrl: url,
    };
  }

  ids = filteredIds;

  const creatorIds = [...ids]
    .map((id) => details.get(id)?.creator)
    .filter((c): c is string => Boolean(c && /^\d{10,}$/.test(c.trim())));
  const creatorNames = creatorIds.length > 0 ? await resolveSteamCreatorNames(creatorIds) : new Map<string, string>();

  const items: WorkshopBrowseItem[] = [];
  for (const id of ids) {
    const d = details.get(id);
    const title = d?.title ?? `Workshop ${id}`;
    if (isJunkWorkshopItem(title, id)) continue;
    const votesUp = d?.votes_up ?? 0;
    const votesDown = d?.votes_down ?? 0;
    const totalVotes = votesUp + votesDown;
    const info = pageInfo.get(id);
    const starScore =
      info?.starRating != null && (info.totalVotes ?? 0) > 0
        ? Math.max(0, Math.min(5, info.starRating))
        : d?.score != null && Number.isFinite(d.score)
        ? Math.max(0, Math.min(5, d.score / 2))
        : totalVotes > 0
          ? Math.max(0, Math.min(5, (votesUp / totalVotes) * 5))
          : undefined;
    const rawCreator = d?.creator?.trim();
    const authorSteamId = rawCreator && /^\d{10,}$/.test(rawCreator) ? rawCreator : undefined;
    const authorDisplay = authorSteamId
      ? formatCreatorDisplay(authorSteamId, creatorNames)
      : rawCreator;
    const tagSplit = splitWorkshopTags(d?.tags);
    items.push({
      workshopId: id,
      appId: q.appId,
      title,
      previewUrl: d?.preview_url,
      author: authorDisplay,
      authorSteamId,
      authorProfileUrl: authorSteamId ? steamProfileUrl(authorSteamId) : undefined,
      timeCreated: d?.time_created,
      timeUpdated: d?.time_updated,
      fileSize: d?.file_size,
      gameVersionTags: tagSplit.gameVersions,
      workshopCategories: tagSplit.categories,
      hiddenOnWorkshop: d?.result != null && d.result !== 1,
      votesUp,
      votesDown,
      starScore,
      totalVotes: info?.totalVotes ?? (totalVotes || undefined),
      description: cleanDescription(d?.description) ?? info?.description,
      lifetimeSubscriptions: info?.subscriptions,
      lifetimeFavorited: info?.favorited,
    });
  }

  const gameModMax = items.length;

  return {
    items,
    page: q.page ?? 1,
    appId: q.appId,
    totalHint: gameModMax,
    ...totals,
    tags,
    sourceUrl: url,
    metadataMatched: items.filter((i) => !i.title.startsWith('Workshop ')).length,
  };
}

/** Cards for specific Workshop items (liked ones that aren't on disk), straight from Steam's details API. */
export async function workshopItemsByIds(pairs: { appId: number; workshopId: string }[]): Promise<WorkshopBrowseItem[]> {
  const ids = [...new Set(pairs.map((p) => p.workshopId).filter((id) => /^\d+$/.test(id)))];
  if (ids.length === 0) return [];
  const details = await fetchWorkshopDetails(ids);
  const creatorIds = ids.map((id) => details.get(id)?.creator).filter((c): c is string => Boolean(c && /^\d{10,}$/.test(c.trim())));
  const creatorNames = creatorIds.length ? await resolveSteamCreatorNames(creatorIds) : new Map<string, string>();
  const out: WorkshopBrowseItem[] = [];
  for (const p of pairs) {
    const d = details.get(p.workshopId);
    if (!d || (d.result != null && d.result !== 1)) continue;
    const votesUp = d.votes_up ?? 0;
    const votesDown = d.votes_down ?? 0;
    const votes = votesUp + votesDown;
    const rawCreator = d.creator?.trim();
    const authorSteamId = rawCreator && /^\d{10,}$/.test(rawCreator) ? rawCreator : undefined;
    const tagSplit = splitWorkshopTags(d.tags);
    out.push({
      workshopId: p.workshopId,
      appId: d.consumer_app_id ?? p.appId,
      title: d.title ?? `Workshop ${p.workshopId}`,
      previewUrl: d.preview_url,
      author: authorSteamId ? formatCreatorDisplay(authorSteamId, creatorNames) : rawCreator,
      authorSteamId,
      authorProfileUrl: authorSteamId ? steamProfileUrl(authorSteamId) : undefined,
      timeCreated: d.time_created,
      timeUpdated: d.time_updated,
      fileSize: d.file_size,
      gameVersionTags: tagSplit.gameVersions,
      workshopCategories: tagSplit.categories,
      votesUp,
      votesDown,
      starScore: votes > 0 ? Math.max(0, Math.min(5, (votesUp / votes) * 5)) : undefined,
      totalVotes: votes || undefined,
      description: cleanDescription(d.description),
      lifetimeSubscriptions: d.lifetime_subscriptions,
      lifetimeFavorited: d.lifetime_favorited,
    });
  }
  return out;
}

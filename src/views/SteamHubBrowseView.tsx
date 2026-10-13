import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type WheelEvent } from 'react';
import type { CatalogSnapshot, SteamLibraryGame, WorkshopBrowseItem, WorkshopBrowseSort } from '@shared/types';
import { WorkshopItemCard } from '../components/WorkshopItemCard';
import { favoriteId, localModForWorkshop } from '../utils/workshopLocal';

type Props = {
  catalog: CatalogSnapshot;
  searchQuery: string;
  /** Rendered at the start of the toolbar (the Steam sub-tabs), so tabs, filters and paging share one row. */
  header?: ReactNode;
};

/** Three rows of seven on a wide window (fewer columns on narrow ones). */
const PAGE_SIZE = 21;
/** Steam's browse page serves fixed page sizes; ModKeeper pages are cut from a continuous run of these. */
const STEAM_PAGE = 30;
/** ModKeeper pages loaded ahead in the background after the one you're on. */
const PREFETCH_PAGES = 2;
const LAST_GAME_KEY = 'modkeeper.browseGame';

/** Workshops that are mostly maps, skins or wallpapers rather than mods: never the default game. */
const NOT_MOD_WORKSHOPS = new Set([
  730, // Counter-Strike 2 / CS:GO
  440, // Team Fortress 2
  570, // Dota 2
  431960, // Wallpaper Engine
  250820, // SteamVR (environments)
]);

type SteamPage = { items: WorkshopBrowseItem[]; error?: string; total?: number; totalPages?: number; tags?: string[] };

/** "Made" filter: Steam's created-date range, in days (0 = any time). */
const PERIODS: { days: number; label: string }[] = [
  { days: 0, label: 'Any time' },
  { days: 7, label: 'Past week' },
  { days: 14, label: 'Past 2 weeks' },
  { days: 30, label: 'Past month' },
  { days: 90, label: 'Past 3 months' },
  { days: 180, label: 'Past 6 months' },
  { days: 365, label: 'Past year' },
];

/** The element that scrolls the page (nearest scrollable ancestor). */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

export function SteamHubBrowseView({ catalog, searchQuery, header }: Props) {
  const [games, setGames] = useState<SteamLibraryGame[]>([]);
  const [appId, setAppId] = useState(108600);
  const [sort, setSort] = useState<WorkshopBrowseSort>('trend');
  const [categoryTag, setCategoryTag] = useState('');
  const [appliedTag, setAppliedTag] = useState('');
  const [periodDays, setPeriodDays] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [steamLastPage, setSteamLastPage] = useState<number | null>(null);
  const [gameTags, setGameTags] = useState<Record<number, string[]>>({});
  const [pageInput, setPageInput] = useState('');
  const [hideInstalled, setHideInstalled] = useState(false);
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<WorkshopBrowseItem[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pendingInstall, setPendingInstall] = useState<Set<string>>(new Set());
  const browseSeq = useRef(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const lastWheelPage = useRef(0);
  /** Steam pages by query + page number; finished ones are also in `done` so cached pages show without a spinner. */
  const steamPages = useRef(new Map<string, Promise<SteamPage>>());
  const done = useRef(new Set<string>());

  const query = searchQuery.trim();
  const queryKey = `${appId}|${sort}|${appliedTag}|${periodDays}|${query}`;

  const fetchSteamPage = useCallback(
    (n: number): Promise<SteamPage> => {
      const key = `${queryKey}|${n}`;
      const cached = steamPages.current.get(key);
      if (cached) return cached;
      const p: Promise<SteamPage> = (window.modHub
        ? window.modHub
            .workshopBrowse({
              appId,
              page: n,
              sort,
              searchText: query || undefined,
              categoryTag: appliedTag || undefined,
              periodDays: periodDays || undefined,
              numPerPage: STEAM_PAGE,
            })
            .then((r): SteamPage => ({ items: r.items, error: r.error, total: r.total, totalPages: r.totalPages, tags: r.tags }))
        : Promise.resolve<SteamPage>({ items: [] })
      )
        .catch((e: unknown): SteamPage => ({ items: [], error: e instanceof Error ? e.message : String(e) }))
        .then((r: SteamPage) => {
          // Keep good pages; let failed ones be fetched again next time.
          if (r.error) steamPages.current.delete(key);
          else done.current.add(key);
          return r;
        });
      steamPages.current.set(key, p);
      return p;
    },
    [queryKey, appId, sort, query, appliedTag, periodDays],
  );

  /** Steam page numbers that hold ModKeeper page `p`. */
  const steamPagesFor = useCallback((p: number) => {
    const start = (p - 1) * PAGE_SIZE;
    const first = Math.floor(start / STEAM_PAGE) + 1;
    const last = Math.floor((start + PAGE_SIZE - 1) / STEAM_PAGE) + 1;
    const out: number[] = [];
    for (let n = first; n <= last; n++) out.push(n);
    return { start, first, pages: out };
  }, []);

  const itemsForPage = useCallback(
    async (p: number): Promise<SteamPage & { more: boolean }> => {
      const { start, first, pages } = steamPagesFor(p);
      const results = await Promise.all(pages.map((n) => fetchSteamPage(n)));
      const err = results.find((r) => r.error)?.error;
      const all = results.flatMap((r) => r.items);
      const offset = start - (first - 1) * STEAM_PAGE;
      const slice = all.slice(offset, offset + PAGE_SIZE);
      const lastFull = (results[results.length - 1]?.items.length ?? 0) >= STEAM_PAGE - 5;
      const info = results.find((r) => r.total != null);
      return {
        items: slice,
        error: slice.length === 0 ? err : undefined,
        more: slice.length === PAGE_SIZE || lastFull,
        total: info?.total,
        totalPages: info?.totalPages,
        tags: results.find((r) => r.tags?.length)?.tags,
      };
    },
    [fetchSteamPage, steamPagesFor],
  );

  const runBrowse = useCallback(async () => {
    const seq = ++browseSeq.current;
    const cached = steamPagesFor(page).pages.every((n) => done.current.has(`${queryKey}|${n}`));
    setError('');
    if (!cached) {
      setLoading(true);
      setItems([]);
    }
    const r = await itemsForPage(page);
    if (seq !== browseSeq.current) return;
    setItems(r.items);
    setHasMore(r.more);
    setTotal(r.total ?? null);
    setSteamLastPage(r.totalPages ?? null);
    if (r.tags?.length) setGameTags((prev) => (prev[appId]?.length ? prev : { ...prev, [appId]: r.tags! }));
    if (r.error) setError(r.error);
    setLoading(false);
    // Load the next pages in the background so paging forward is instant.
    for (let k = 1; k <= PREFETCH_PAGES; k++) void itemsForPage(page + k);
  }, [page, queryKey, itemsForPage, steamPagesFor, appId]);

  const loadGames = useCallback(async () => {
    if (!window.modHub) return;
    const g = await window.modHub.getSteamLibraryGames();
    const workshopGames = g.filter((x) => x.hasWorkshopBrowse !== false);
    setGames(workshopGames);
    let remembered = 0;
    try {
      remembered = Number(localStorage.getItem(LAST_GAME_KEY)) || 0;
    } catch {
      /* storage unavailable */
    }
    const pick =
      workshopGames.find((x) => x.appId === remembered) ??
      [...workshopGames]
        .filter((x) => !NOT_MOD_WORKSHOPS.has(x.appId) && (x.localWorkshopCount ?? 0) > 0)
        .sort((a, b) => (b.localWorkshopCount ?? 0) - (a.localWorkshopCount ?? 0))[0] ??
      workshopGames.find((x) => x.ownedOnDisk && x.hasWorkshopBrowse && !NOT_MOD_WORKSHOPS.has(x.appId));
    if (pick) setAppId(pick.appId);
  }, []);

  const loadFavorites = useCallback(async () => {
    if (!window.modHub) return;
    const ids = await window.modHub.getFavoriteIds();
    setFavorites(new Set(ids));
  }, []);

  useEffect(() => {
    void loadGames();
    void loadFavorites();
    window.modHub?.getSettings().then((s) => {
      const ids = new Set((s.workshopInstallOnce ?? []).map((x) => favoriteId(x.appId, x.workshopId)));
      setPendingInstall(ids);
    });
  }, [loadGames, loadFavorites]);

  useEffect(() => {
    void runBrowse();
  }, [runBrowse]);

  // A new search starts at page 1.
  useEffect(() => {
    setPage(1);
  }, [query]);

  const visibleItems = useMemo(() => {
    if (!hideInstalled) return items;
    return items.filter((item) => !localModForWorkshop(catalog, item.appId, item.workshopId));
  }, [items, hideInstalled, catalog]);

  /** Last ModKeeper page: Steam's count, capped where Steam stops paging. */
  const maxPage =
    total != null ? Math.max(1, Math.ceil(Math.min(total, (steamLastPage ?? Infinity) * STEAM_PAGE) / PAGE_SIZE)) : undefined;

  function goToPage(next: number, jump = false) {
    if (next < 1 || (!jump && next > page && !hasMore) || (maxPage && next > maxPage)) return;
    setPage(next);
    scrollParent(gridRef.current)?.scrollTo({ top: 0 });
  }

  /**
   * Mouse wheel turns pages: past the bottom of a page (or on a page that fits the screen) it goes to the next one, at the
   * top it goes back. One page per ~0.7 s so a single flick doesn't skip several.
   */
  function onWheelPage(e: WheelEvent) {
    if (loading || Math.abs(e.deltaY) < 1) return;
    const now = Date.now();
    if (now - lastWheelPage.current < 700) return;
    const sp = scrollParent(gridRef.current);
    const atBottom = !sp || sp.scrollTop + sp.clientHeight >= sp.scrollHeight - 40;
    const atTop = !sp || sp.scrollTop <= 40;
    if (e.deltaY > 0 && atBottom && hasMore) {
      lastWheelPage.current = now;
      goToPage(page + 1);
    } else if (e.deltaY < 0 && atTop && page > 1) {
      lastWheelPage.current = now;
      goToPage(page - 1);
    }
  }

  // Wide windows: the three rows fill the screen, and descriptions take whatever room is left on each card.
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const fit = () => {
      const top = el.getBoundingClientRect().top + (scrollParent(el)?.scrollTop ?? 0);
      el.style.setProperty('--grid-top', `${Math.max(0, Math.round(top))}px`);
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [items.length, loading]);

  function refresh() {
    for (const k of [...steamPages.current.keys()]) if (k.startsWith(`${queryKey}|`)) steamPages.current.delete(k);
    for (const k of [...done.current]) if (k.startsWith(`${queryKey}|`)) done.current.delete(k);
    void runBrowse();
  }

  async function toggleFavorite(item: WorkshopBrowseItem) {
    const id = favoriteId(item.appId, item.workshopId);
    const local = localModForWorkshop(catalog, item.appId, item.workshopId);
    const next = !favorites.has(id) && !(local?.favorited ?? false);
    if (local) await window.modHub?.setFavorite(local.id, next);
    else await window.modHub?.setFavorite(id, next);
    await loadFavorites();
  }

  async function favoriteInstall(item: WorkshopBrowseItem) {
    await window.modHub?.workshopFavoriteInstall(item.appId, item.workshopId);
    setPendingInstall((prev) => new Set(prev).add(favoriteId(item.appId, item.workshopId)));
    await loadFavorites();
  }

  async function subscribe(item: WorkshopBrowseItem) {
    const local = localModForWorkshop(catalog, item.appId, item.workshopId);
    await window.modHub?.steamSubscribe(item.appId, item.workshopId);
    if (local) await window.modHub?.setSubscribed(local.id, true);
  }

  return (
    <>
      <div className="filter-row subtabs-row workshop-hub-filters">
        {header}
        <label>
          Game
          <select
            value={appId}
            onChange={(e) => {
              setAppId(Number(e.target.value));
              setPage(1);
              try {
                localStorage.setItem(LAST_GAME_KEY, e.target.value);
              } catch {
                /* storage unavailable */
              }
            }}
          >
            {games.map((g) => (
              <option key={g.appId} value={g.appId}>
                {g.name}
                {g.ownedOnDisk ? ' · Installed' : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          Sort
          <select
            value={sort}
            onChange={(e) => {
              setSort(e.target.value as WorkshopBrowseSort);
              setPage(1);
            }}
          >
            <option value="trend">Trending</option>
            <option value="recent">Most recent</option>
            <option value="updated">Recently updated</option>
            <option value="subscribed">Most subscribed</option>
            <option value="rated">Top rated</option>
          </select>
        </label>
        <label title="Only mods made in this period">
          Made
          <select
            value={periodDays}
            onChange={(e) => {
              setPeriodDays(Number(e.target.value));
              setPage(1);
            }}
          >
            {PERIODS.map((p) => (
              <option key={p.days} value={p.days}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {(gameTags[appId]?.length ?? 0) > 0 ? (
          <label title="Only mods with this Workshop tag (game versions like Build 42 are tags too)">
            Tag
            <select
              value={appliedTag}
              onChange={(e) => {
                setAppliedTag(e.target.value);
                setCategoryTag(e.target.value);
                setPage(1);
              }}
            >
              <option value="">Any tag</option>
              {appliedTag && !gameTags[appId].includes(appliedTag) && <option value={appliedTag}>{appliedTag}</option>}
              {gameTags[appId].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <input
            type="text"
            className="workshop-tag-input"
            placeholder="Steam tag (optional)"
            title="Only items with this Workshop tag. Press Enter to apply."
            value={categoryTag}
            onChange={(e) => setCategoryTag(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setAppliedTag(categoryTag.trim());
                setPage(1);
              }
            }}
            onBlur={() => {
              if (categoryTag.trim() !== appliedTag) {
                setAppliedTag(categoryTag.trim());
                setPage(1);
              }
            }}
          />
        )}
        <label className="checkbox-inline">
          <input type="checkbox" checked={hideInstalled} onChange={(e) => setHideInstalled(e.target.checked)} />
          Hide installed
        </label>
        <button type="button" className="btn btn-sm" disabled={loading} title="Load this page again from Steam" onClick={refresh}>
          {loading ? 'Loading…' : '⟳ Refresh'}
        </button>
        <div className="pagination-inline">
          <button type="button" className="btn btn-sm" disabled={loading || page <= 1} onClick={() => goToPage(page - 1)} title="Previous page">
            ‹
          </button>
          {total != null && <span className="gb-total">{total.toLocaleString()} mods ·</span>}
          <span>Page</span>
          <input
            type="text"
            inputMode="numeric"
            className="page-input"
            value={pageInput || String(page)}
            title="Type a page number and press Enter"
            onFocus={(e) => e.target.select()}
            onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              const n = Number(pageInput);
              if (n >= 1) goToPage(maxPage ? Math.min(n, maxPage) : n, true);
              setPageInput('');
            }}
            onBlur={() => setPageInput('')}
          />
          {maxPage != null && <span>of {maxPage.toLocaleString()}</span>}
          <button type="button" className="btn btn-sm" disabled={loading || !hasMore || (maxPage != null && page >= maxPage)} onClick={() => goToPage(page + 1)} title="Next page (or scroll down)">
            ›
          </button>
        </div>
      </div>
      {error && <p className="message message-error">{error}</p>}
      {loading && visibleItems.length === 0 ? (
        <div className="empty-state">Loading Workshop…</div>
      ) : visibleItems.length === 0 ? (
        <div className="empty-state">No items — try another game, page, or turn off Hide installed.</div>
      ) : (
        <div className="workshop-browse-grid grid-fill" ref={gridRef} onWheel={onWheelPage}>
          {visibleItems.map((item) => {
            const local = localModForWorkshop(catalog, item.appId, item.workshopId);
            const favId = favoriteId(item.appId, item.workshopId);
            const favorited = local?.favorited ?? favorites.has(favId);
            const subscribed = local?.subscribed ?? false;
            const installing = pendingInstall.has(favId) && !local;
            return (
              <WorkshopItemCard
                key={`${item.appId}-${item.workshopId}`}
                item={item}
                installed={Boolean(local)}
                favorited={favorited}
                subscribed={subscribed}
                installing={installing}
                onFavorite={() => void toggleFavorite(item)}
                onInstall={() => void favoriteInstall(item)}
                onSubscribe={() => void subscribe(item)}
              />
            );
          })}
        </div>
      )}
    </>
  );
}

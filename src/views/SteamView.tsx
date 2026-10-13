import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CatalogSnapshot, ModRecord, ViewMode, WorkshopBrowseItem } from '@shared/types';
import { ModCollectionView } from '../components/ModCollectionView';
import { SubTabs } from '../components/SubTabs';
import { EmbeddedWebView } from '../components/EmbeddedWebView';
import { useHubNavigation } from '../context/HubNavigation';
import { steamAppIdForGameId } from '../utils/games';
import { workshopBrowseUrl, type WorkshopBrowseSort } from '../utils/steamImages';
import { SteamHubBrowseView } from './SteamHubBrowseView';
import { favoriteId, localModForWorkshop } from '../utils/workshopLocal';
import { WorkshopItemCard } from '../components/WorkshopItemCard';

type InstalledShow = 'installed' | 'liked';
const SHOW_KEY = 'modkeeper.steamShow';

type Props = {
  catalog: CatalogSnapshot;
  searchQuery: string;
  viewMode: ViewMode;
  trackedNexus?: Set<string>;
  onTrackedNexusChange?: () => void;
  onFavorite: (mod: ModRecord) => void;
  onDismiss?: (mod: ModRecord) => void;
  onSubscribe: (mod: ModRecord) => void;
  onDeleteLocal?: (mod: ModRecord) => void;
  onSteamGameFilter: (gameId: string) => void;
};

function matchSearch(m: ModRecord, q: string): boolean {
  if (!q) return true;
  const lower = q.toLowerCase();
  return (
    m.title.toLowerCase().includes(lower) ||
    m.gameId.toLowerCase().includes(lower) ||
    m.author?.toLowerCase().includes(lower) ||
    m.workshopId?.includes(lower) === true
  );
}

export function SteamView({
  catalog,
  searchQuery,
  viewMode,
  trackedNexus,
  onTrackedNexusChange,
  onFavorite,
  onDismiss,
  onSubscribe,
  onDeleteLocal,
  onSteamGameFilter,
}: Props) {
  const { steamPanel, setSteamPanel, steamGameFilter, setSteamGameFilter } = useHubNavigation();
  const [browseSort, setBrowseSort] = useState<WorkshopBrowseSort>('trend');
  // Downloaded / installed: what's on disk, or what you've liked (on disk or not)
  const [show, setShowState] = useState<InstalledShow>(() => {
    try {
      return localStorage.getItem(SHOW_KEY) === 'liked' ? 'liked' : 'installed';
    } catch {
      return 'installed';
    }
  });
  const setShow = (v: InstalledShow) => {
    setShowState(v);
    try {
      localStorage.setItem(SHOW_KEY, v);
    } catch {
      /* storage unavailable */
    }
  };
  const [hideInstalled, setHideInstalled] = useState(false);
  const [favoriteIds, setFavoriteIds] = useState<string[]>([]);
  const [likedRemote, setLikedRemote] = useState<WorkshopBrowseItem[]>([]);
  const [likedLoading, setLikedLoading] = useState(false);
  const [pendingInstall, setPendingInstall] = useState<Set<string>>(new Set());
  const loadFavoriteIds = useCallback(async () => {
    if (window.modHub) setFavoriteIds(await window.modHub.getFavoriteIds());
  }, []);
  useEffect(() => {
    if (show === 'liked') void loadFavoriteIds();
  }, [show, loadFavoriteIds]);

  const workshopByGame = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of catalog.mods) {
      if (m.source !== 'steam-workshop') continue;
      map.set(m.gameId, (map.get(m.gameId) ?? 0) + 1);
    }
    return map;
  }, [catalog.mods]);

  const gamesWithWorkshop = useMemo(() => {
    // Installed list: only games with Workshop items on disk. Browse: any Steam game, so new Workshops can be explored.
    const base = catalog.games.filter(
      (g) => (workshopByGame.get(g.id) ?? 0) > 0 || (steamPanel === 'browse' && g.steamAppId) || g.id === steamGameFilter,
    );
    const known = new Set(base.map((g) => g.id));
    const extras = [...workshopByGame.entries()]
      .filter(([id, n]) => n > 0 && !known.has(id))
      .map(([id]) => {
        const appId = steamAppIdForGameId(id);
        return {
          id,
          name: appId ? `Steam app ${appId}` : id,
          steamAppId: appId,
          modFolderHints: [],
        };
      });
    return [...base, ...extras];
  }, [catalog.games, workshopByGame, steamPanel, steamGameFilter]);

  const browseGameId =
    steamGameFilter === 'all' ? (gamesWithWorkshop[0]?.id ?? 'project-zomboid') : steamGameFilter;
  const appId = steamAppIdForGameId(browseGameId) ?? 108600;

  const installed = useMemo(() => {
    const filterAppId =
      steamGameFilter !== 'all' ? steamAppIdForGameId(steamGameFilter) : undefined;
    return catalog.mods.filter((m) => {
      if (m.source !== 'steam-workshop') return false;
      if (steamGameFilter !== 'all') {
        const modApp = m.steamAppId ?? steamAppIdForGameId(m.gameId);
        if (m.gameId !== steamGameFilter && modApp !== filterAppId) return false;
      }
      return matchSearch(m, searchQuery.trim());
    });
  }, [catalog.mods, steamGameFilter, searchQuery]);

  /** Liked Workshop items that aren't on disk ("ws-<app>-<id>" favorites), for the chosen game. */
  const likedPairs = useMemo(() => {
    const filterAppId = steamGameFilter !== 'all' ? steamAppIdForGameId(steamGameFilter) : undefined;
    return favoriteIds
      .map((id) => /^ws-(\d+)-(\d+)$/.exec(id))
      .filter((m): m is RegExpExecArray => m != null)
      .map((m) => ({ appId: Number(m[1]), workshopId: m[2] }))
      .filter((p) => (!filterAppId || p.appId === filterAppId) && !localModForWorkshop(catalog, p.appId, p.workshopId));
  }, [favoriteIds, steamGameFilter, catalog]);
  const likedKey = likedPairs.map((p) => p.workshopId).join(',');
  useEffect(() => {
    if (show !== 'liked' || !window.modHub) return;
    if (!likedKey) {
      setLikedRemote([]);
      return;
    }
    let live = true;
    setLikedLoading(true);
    void window.modHub
      .workshopItems(likedPairs)
      .then((items) => live && setLikedRemote(items))
      .finally(() => live && setLikedLoading(false));
    return () => {
      live = false;
    };
    // likedKey stands for likedPairs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, likedKey]);
  const likedInstalled = useMemo(() => installed.filter((m) => m.favorited), [installed]);
  const q = searchQuery.trim().toLowerCase();
  const likedRemoteShown = likedRemote.filter(
    (i) => likedPairs.some((p) => p.workshopId === i.workshopId) && (!q || `${i.title} ${i.author ?? ''} ${i.workshopId}`.toLowerCase().includes(q)),
  );

  async function unlikeRemote(item: WorkshopBrowseItem) {
    await window.modHub?.setFavorite(favoriteId(item.appId, item.workshopId), false);
    await loadFavoriteIds();
  }
  async function installRemote(item: WorkshopBrowseItem) {
    await window.modHub?.workshopFavoriteInstall(item.appId, item.workshopId);
    setPendingInstall((prev) => new Set(prev).add(favoriteId(item.appId, item.workshopId)));
  }

  const localNonWorkshopForGame = useMemo(() => {
    if (steamGameFilter === 'all') return 0;
    return catalog.mods.filter(
      (m) => m.gameId === steamGameFilter && m.source !== 'steam-workshop',
    ).length;
  }, [catalog.mods, steamGameFilter]);

  const browseUrl = workshopBrowseUrl(appId, browseSort);

  function onGameSelect(id: string) {
    setSteamGameFilter(id);
    onSteamGameFilter(id);
  }

  const tabs = (
    <SubTabs
      tabs={[
        { id: 'installed' as const, label: 'Downloaded / installed' },
        { id: 'hub-browse' as const, label: 'ModKeeper browse' },
        { id: 'browse' as const, label: 'Browse Workshop (web)' },
      ]}
      active={steamPanel}
      onChange={setSteamPanel}
    />
  );

  return (
    <>
      {steamPanel !== 'hub-browse' && (
        <div className="filter-row subtabs-row">
          {tabs}
          <label>
            Game
            <select value={steamGameFilter} onChange={(e) => onGameSelect(e.target.value)}>
              <option value="all">All games</option>
              {gamesWithWorkshop.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} ({workshopByGame.get(g.id) ?? 0} Workshop)
                </option>
              ))}
            </select>
          </label>
          {steamPanel === 'installed' && (
            <>
              <label title="Installed: Workshop mods on disk. Liked: mods you've hearted, installed or not.">
                Show
                <select value={show} onChange={(e) => setShow(e.target.value as InstalledShow)}>
                  <option value="installed">Installed</option>
                  <option value="liked">Liked</option>
                </select>
              </label>
              {show === 'liked' && (
                <label className="checkbox-inline">
                  <input type="checkbox" checked={hideInstalled} onChange={(e) => setHideInstalled(e.target.checked)} />
                  Hide installed
                </label>
              )}
            </>
          )}
          {steamPanel === 'browse' && (
            <label>
              Sort
              <select value={browseSort} onChange={(e) => setBrowseSort(e.target.value as WorkshopBrowseSort)}>
                <option value="trend">Trending</option>
                <option value="recent">Most recent</option>
                <option value="subscribed">Most subscribed</option>
                <option value="rated">Top rated</option>
              </select>
            </label>
          )}
        </div>
      )}
      {steamPanel === 'hub-browse' ? (
        <SteamHubBrowseView catalog={catalog} searchQuery={searchQuery} header={tabs} />
      ) : steamPanel === 'installed' && show === 'liked' ? (
        <>
          {!hideInstalled && likedInstalled.length > 0 && (
            <ModCollectionView
              mods={likedInstalled}
              games={catalog.games}
              viewMode={viewMode}
              cardVariant="steam"
              trackedNexus={trackedNexus}
              onTrackedNexusChange={onTrackedNexusChange}
              onFavorite={onFavorite}
              onDismiss={onDismiss}
              onSubscribe={onSubscribe}
              onDeleteLocal={onDeleteLocal}
              emptyMessage=""
            />
          )}
          {likedRemoteShown.length > 0 && (
            <>
              <h3 className="section-heading">Liked, not installed ({likedRemoteShown.length})</h3>
              <div className="workshop-browse-grid workshop-liked-grid">
                {likedRemoteShown.map((item) => (
                  <WorkshopItemCard
                    key={`${item.appId}-${item.workshopId}`}
                    item={item}
                    installed={false}
                    favorited
                    subscribed={false}
                    installing={pendingInstall.has(favoriteId(item.appId, item.workshopId))}
                    onFavorite={() => void unlikeRemote(item)}
                    onInstall={() => void installRemote(item)}
                    onSubscribe={() => void window.modHub?.steamSubscribe(item.appId, item.workshopId)}
                  />
                ))}
              </div>
            </>
          )}
          {likedLoading && likedRemoteShown.length === 0 && <div className="empty-state">Loading liked mods from Steam…</div>}
          {!likedLoading && likedRemoteShown.length === 0 && (hideInstalled || likedInstalled.length === 0) && (
            <div className="empty-state">
              {hideInstalled ? 'Every liked mod for this filter is installed.' : 'No liked mods for this filter yet. Use ♡ on a card to like one.'}
            </div>
          )}
        </>
      ) : steamPanel === 'installed' ? (
        <>
          {installed.length === 0 && localNonWorkshopForGame > 0 && (
            <p className="message">
              {localNonWorkshopForGame} local mod(s) for this game (Vortex/Nexus/folders) — open{' '}
              <strong>All mods</strong> with the same game filter. None are Steam Workshop folders here.
            </p>
          )}
          <ModCollectionView
            mods={installed}
            games={catalog.games}
            viewMode={viewMode}
            cardVariant="steam"
            trackedNexus={trackedNexus}
            onTrackedNexusChange={onTrackedNexusChange}
            onFavorite={onFavorite}
            onDismiss={onDismiss}
            onSubscribe={onSubscribe}
            onDeleteLocal={onDeleteLocal}
            emptyMessage="No Workshop items on disk for this filter. Subscribe in Workshop browse, then rescan."
          />
        </>
      ) : (
        <>
          <EmbeddedWebView src={browseUrl} title="Steam Workshop" partition="persist:modhub-steam-workshop" />
        </>
      )}
    </>
  );
}

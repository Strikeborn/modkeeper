import { useCallback, useEffect, useRef, useState, type ReactNode, type WheelEvent } from 'react';
import type { GbFile, GbGame, GbMod, GbModDetails, GbSort, HubSettings } from '@shared/types';
import { ModThumbnail } from '../components/ModThumbnail';
import { toast } from '../utils/toast';
import { defaultGbFiles } from '../utils/gbFiles';
import { scrollParent, useGridTop } from '../utils/fillHeight';
import { formatBytes } from '../utils/format';

type Props = {
  /** Emulation sub-tabs, shown at the start of the toolbar. */
  header?: ReactNode;
  /** Ship of Harkinian is in the library (its mods install straight into its mods folder). */
  /** Ports in the emulation library that installs can go straight into (by GameBanana game id). */
  installablePorts: Record<number, string>;
  onInstalled?: () => void;
};

/** Four rows of seven on a wide window. */
const PAGE_SIZE = 28;
/** GameBanana is asked for this many at a time; ModKeeper pages are cut from the run, so filtered-out mods leave no gaps. */
const SOURCE_SIZE = 50;
const PREFETCH_PAGES = 2;
const SHIP: GbGame = { id: 16121, name: 'Ship of Harkinian (Ocarina of Time PC Port)' };

/** GameBanana games worth having one click away: PC ports first, then emulated games with big mod scenes. */
const GAME_GROUPS: { label: string; games: GbGame[] }[] = [
  {
    label: 'PC ports',
    games: [
      SHIP,
      { id: 20371, name: "2Ship2Harkinian (Majora's Mask PC Port)" },
      { id: 21763, name: "Zelda64: Recompiled (Majora's Mask)" },
      { id: 21612, name: 'Starship (Star Fox 64 PC Port)' },
      { id: 9790, name: 'Super Mario 64 PC Port' },
      { id: 20003, name: 'Super Mario 64 Co-op (EX & DX)' },
      { id: 24169, name: 'Banjo: Recompiled' },
      { id: 25172, name: 'Lighthouse (Banjo-Kazooie PC Port)' },
      { id: 6786, name: 'Sonic Robo Blast 2' },
    ],
  },
  {
    label: 'Emulated',
    games: [
      { id: 7060, name: 'The Legend of Zelda: Ocarina of Time' },
      { id: 16698, name: "The Legend of Zelda: Majora's Mask" },
      { id: 7534, name: 'Ocarina of Time 3D' },
      { id: 7533, name: "Majora's Mask 3D" },
      { id: 5710, name: 'Super Mario 64' },
      { id: 6449, name: 'Super Mario World' },
      { id: 5950, name: 'Super Mario Galaxy' },
      { id: 6867, name: 'Super Mario Galaxy 2' },
      { id: 6376, name: 'Super Mario Odyssey' },
      { id: 14425, name: 'Pokémon Emerald' },
      { id: 5896, name: 'Mario Kart Wii' },
      { id: 6507, name: 'Mario Kart 8 Deluxe' },
      { id: 5706, name: 'Super Smash Bros. Melee' },
      { id: 6498, name: 'Super Smash Bros. Ultimate' },
      { id: 5866, name: 'Zelda: Breath of the Wild (Wii U)' },
      { id: 7617, name: 'Zelda: Tears of the Kingdom' },
    ],
  },
];

type Page = { mods: GbMod[]; complete: boolean; total: number; perPage: number; error?: string };

function compact(n?: number): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

function shortDate(sec?: number) {
  return sec ? new Date(sec * 1000).toLocaleDateString() : '—';
}

/** GameBanana mods (Mods section only, SFW) for any game: install, favorite, open the page to like it there. */
export function GameBananaView({ header, installablePorts, onInstalled }: Props) {
  const [settings, setSettings] = useState<HubSettings | null>(null);
  const [game, setGame] = useState<GbGame>(SHIP);
  const [gameQuery, setGameQuery] = useState('');
  const [gameMatches, setGameMatches] = useState<GbGame[]>([]);
  const [sort, setSort] = useState<GbSort>('liked');
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [showFavorites, setShowFavorites] = useState(false);
  const [page, setPage] = useState(1);
  const [mods, setMods] = useState<GbMod[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [total, setTotal] = useState<number | null>(null);
  const [perPageSeen, setPerPageSeen] = useState(PAGE_SIZE);
  const [pageInput, setPageInput] = useState('');
  const [details, setDetails] = useState<Record<number, GbModDetails>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [installing, setInstalling] = useState<Set<number>>(new Set());
  const gridRef = useRef<HTMLDivElement>(null);
  const lastWheel = useRef(0);
  const seq = useRef(0);
  const pages = useRef(new Map<string, Promise<Page>>());
  const done = useRef(new Set<string>());

  useEffect(() => {
    void window.modHub?.getSettings().then((s) => {
      setSettings(s);
      if (s.gbGame?.id) setGame(s.gbGame);
    });
  }, []);

  const queryKey = `${game.id}|${sort}|${appliedSearch}`;

  /** One page of GameBanana's own results (SOURCE_SIZE, or the search endpoint's fixed size). */
  const fetchSource = useCallback(
    (n: number): Promise<Page> => {
      const key = `${queryKey}|${n}`;
      const cached = pages.current.get(key);
      if (cached) return cached;
      const pr = window.modHub
        .gbListMods({ gameId: game.id, sort, page: n, perPage: SOURCE_SIZE, search: appliedSearch || undefined })
        .then((r): Page => ({ mods: r.mods, complete: r.complete || r.mods.length === 0, total: r.total, perPage: r.perPage ?? SOURCE_SIZE, error: r.error }))
        .catch((e: unknown): Page => ({ mods: [], complete: true, total: 0, perPage: SOURCE_SIZE, error: e instanceof Error ? e.message : String(e) }))
        .then((r: Page) => {
          if (r.error) pages.current.delete(key);
          return r;
        });
      pages.current.set(key, pr);
      return pr;
    },
    [queryKey, game.id, sort, appliedSearch],
  );

  /** ModKeeper page `p`: a slice of the continuous run of GameBanana results, fetched as far as needed. */
  const fetchPage = useCallback(
    async (p: number): Promise<Page> => {
      const need = p * PAGE_SIZE;
      const first = await fetchSource(1);
      const per = Math.max(1, first.perPage || SOURCE_SIZE);
      const results = [first, ...(await Promise.all(Array.from({ length: Math.max(0, Math.ceil(need / per) - 1) }, (_, k) => fetchSource(k + 2))))];
      let all = results.flatMap((r) => r.mods);
      let last = results[results.length - 1];
      // some results are filtered out (NSFW / rated), so a page may need one more batch
      while (all.length < need && !last.complete && !last.error) {
        last = await fetchSource(results.length + 1);
        results.push(last);
        all = all.concat(last.mods);
      }
      const mods = all.slice((p - 1) * PAGE_SIZE, need);
      const error = results.find((r) => r.error)?.error;
      if (!error) done.current.add(`${queryKey}|ui${p}`);
      return { mods, complete: all.length <= need && last.complete, total: first.total, perPage: PAGE_SIZE, error: mods.length ? undefined : error };
    },
    [fetchSource, queryKey],
  );

  const loadDetails = useCallback(async (list: GbMod[]) => {
    const ids = list.map((m) => m.id);
    if (ids.length === 0) return;
    const d = await window.modHub.gbModDetails(ids);
    setDetails((prev) => ({ ...prev, ...d }));
  }, []);

  const run = useCallback(async () => {
    if (showFavorites) return;
    const s = ++seq.current;
    setError('');
    if (!done.current.has(`${queryKey}|ui${page}`)) {
      setLoading(true);
      setMods([]);
    }
    const r = await fetchPage(page);
    if (s !== seq.current) return;
    setMods(r.mods);
    setHasMore(!r.complete);
    setTotal(r.total);
    setPerPageSeen(r.perPage);
    if (r.error) setError(r.error);
    setLoading(false);
    void loadDetails(r.mods);
    for (let k = 1; k <= PREFETCH_PAGES; k++) void fetchPage(page + k).then((n) => void loadDetails(n.mods));
  }, [showFavorites, queryKey, page, fetchPage, loadDetails]);

  useEffect(() => {
    void run();
  }, [run]);

  // Favorites view: what's saved, details fetched for their cards.
  const favorites = settings?.gbFavorites ?? [];
  const favIds = new Set(favorites.map((f) => f.id));
  useEffect(() => {
    if (!showFavorites) return;
    setMods(
      favorites.map((f) => ({ id: f.id, name: f.name, url: f.url, gameId: f.gameId, hasFiles: true }) as GbMod),
    );
    setHasMore(false);
    void loadDetails(favorites.map((f) => ({ id: f.id }) as GbMod));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showFavorites, settings?.gbFavorites]);

  async function chooseGame(g: GbGame) {
    setGame(g);
    setGameQuery('');
    setGameMatches([]);
    setPage(1);
    const known = GAME_GROUPS.some((grp) => grp.games.some((x) => x.id === g.id));
    const recent = known ? (settings?.gbRecentGames ?? []) : [g, ...(settings?.gbRecentGames ?? []).filter((x) => x.id !== g.id)].slice(0, 8);
    setSettings(await window.modHub.saveSettings({ gbGame: g, gbRecentGames: recent }));
  }

  const allGames = [...GAME_GROUPS.flatMap((g) => g.games), ...(settings?.gbRecentGames ?? [])];
  const maxPage = total != null && perPageSeen > 0 ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : undefined;

  async function findGames() {
    const q = gameQuery.trim();
    if (q.length < 2) return;
    const r = await window.modHub.gbSearchGames(q);
    setGameMatches(r);
    if (r.length === 0) toast(`No GameBanana game matches “${q}”`);
  }

  async function toggleFavorite(m: GbMod) {
    const list = favIds.has(m.id)
      ? favorites.filter((f) => f.id !== m.id)
      : [...favorites, { id: m.id, name: m.name, url: m.url, gameId: m.gameId ?? game.id }];
    setSettings(await window.modHub.saveSettings({ gbFavorites: list }));
  }

  /** Mods with several files: choose which to install (model, equipment, versions...). */
  const [picker, setPicker] = useState<{ mod: GbMod; files: GbFile[]; selected: Set<number> } | null>(null);

  async function install(m: GbMod, fileIds?: number[]) {
    if (!fileIds) {
      const d = details[m.id] ?? (await window.modHub.gbModDetails([m.id]))[m.id];
      const files = (d?.files ?? []).filter((f) => f.avResult !== 'infected');
      if (files.length > 1) {
        setPicker({ mod: m, files, selected: new Set(defaultGbFiles(files)) });
        return;
      }
    }
    setInstalling((s) => new Set(s).add(m.id));
    try {
      const r = await window.modHub.gbInstall(m.id, m.gameId ?? game.id, fileIds);
      toast(r.message, r.ok ? 'ok' : 'error');
      if (r.ok) onInstalled?.();
    } finally {
      setInstalling((s) => {
        const n = new Set(s);
        n.delete(m.id);
        return n;
      });
    }
  }

  useGridTop(gridRef, [mods.length, loading, showFavorites]);

  function goToPage(p: number, jump = false) {
    if (p < 1 || (!jump && p > page && !hasMore)) return;
    setPage(p);
    scrollParent(gridRef.current)?.scrollTo({ top: 0 });
  }

  function onWheel(e: WheelEvent) {
    if (loading || showFavorites || Math.abs(e.deltaY) < 1) return;
    const now = Date.now();
    if (now - lastWheel.current < 700) return;
    const sp = scrollParent(gridRef.current);
    const atBottom = !sp || sp.scrollTop + sp.clientHeight >= sp.scrollHeight - 40;
    const atTop = !sp || sp.scrollTop <= 40;
    if (e.deltaY > 0 && atBottom && hasMore) {
      lastWheel.current = now;
      goToPage(page + 1);
    } else if (e.deltaY < 0 && atTop && page > 1) {
      lastWheel.current = now;
      goToPage(page - 1);
    }
  }

  /** The PC port this game's mods install into, when it's in the library. */
  const portName = installablePorts[game.id];
  const isPortGame = [SHIP.id, 20371, 21612].includes(game.id);
  // with Show mature mods off, also drop ones only the details call reveals as NSFW
  const visible = settings?.gbShowMature === false ? mods.filter((m) => !details[m.id]?.nsfw) : mods;

  const pickerDialog = picker && (
    <div className="modal-backdrop" role="presentation" onClick={() => setPicker(null)}>
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="gb-pick-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="gb-pick-title">{picker.mod.name}: which files?</h2>
        <p className="modal-text">
          This mod has {picker.files.length} files. Files from the newest upload are ticked (a model and its equipment usually come
          together); ones the author marks outdated aren't.
        </p>
        <table className="mod-table gb-file-table">
          <tbody>
            {[...picker.files]
              .sort((a, b) => (b.added ?? 0) - (a.added ?? 0))
              .map((f) => (
                <tr key={f.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={picker.selected.has(f.id)}
                      onChange={(e) => {
                        const next = new Set(picker.selected);
                        if (e.target.checked) next.add(f.id);
                        else next.delete(f.id);
                        setPicker({ ...picker, selected: next });
                      }}
                    />
                  </td>
                  <td className="col-title">
                    {f.description || f.name}
                    {f.description && <div className="emu-hack-line">{f.name}</div>}
                  </td>
                  <td className="col-num">{formatBytes(f.size)}</td>
                  <td className="col-date">{shortDate(f.added)}</td>
                  <td title="GameBanana's own antivirus result">{f.avResult ?? '—'}</td>
                </tr>
              ))}
          </tbody>
        </table>
        <div className="modal-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={picker.selected.size === 0}
            onClick={() => {
              const p = picker;
              setPicker(null);
              void install(p.mod, [...p.selected]);
            }}
          >
            Install {picker.selected.size} file{picker.selected.size === 1 ? '' : 's'}
          </button>
          <button type="button" className="btn" onClick={() => setPicker(null)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="emu">
      {pickerDialog}
      <div className="filter-row subtabs-row workshop-hub-filters">
        {header}
        <select
          className="gb-game-select"
          value={game.id}
          title={game.name}
          onChange={(e) => {
            const g = allGames.find((x) => String(x.id) === e.target.value);
            if (g) void chooseGame(g);
          }}
        >
          {!allGames.some((x) => x.id === game.id) && <option value={game.id}>{game.name}</option>}
          {GAME_GROUPS.map((grp) => (
            <optgroup key={grp.label} label={grp.label}>
              {grp.games.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </optgroup>
          ))}
          {(settings?.gbRecentGames ?? []).length > 0 && (
            <optgroup label="Recent">
              {(settings?.gbRecentGames ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <input
          type="text"
          className="workshop-tag-input"
          placeholder="Other game…"
          title="Find a game on GameBanana (Enter)"
          value={gameQuery}
          onChange={(e) => setGameQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void findGames()}
        />
        {gameMatches.length > 0 && (
          <select
            value=""
            onChange={(e) => {
              const g = gameMatches.find((x) => String(x.id) === e.target.value);
              if (g) void chooseGame(g);
            }}
          >
            <option value="">{gameMatches.length} match{gameMatches.length === 1 ? '' : 'es'} — choose…</option>
            {gameMatches.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        )}

        <label>
          Sort
          <select
            value={sort}
            disabled={Boolean(appliedSearch)}
            title={appliedSearch ? 'Search results are sorted by best match' : undefined}
            onChange={(e) => {
              setSort(e.target.value as GbSort);
              setPage(1);
            }}
          >
            <option value="liked">Most liked</option>
            <option value="downloaded">Most downloaded</option>
            <option value="viewed">Most viewed</option>
            <option value="newest">Newest</option>
            <option value="updated">Recently updated</option>
          </select>
        </label>
        <input
          type="text"
          className="workshop-tag-input"
          placeholder="Search mods"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setAppliedSearch(search.trim());
              setPage(1);
            }
          }}
          onBlur={() => {
            if (search.trim() !== appliedSearch) {
              setAppliedSearch(search.trim());
              setPage(1);
            }
          }}
        />
        <label className="checkbox-inline">
          <input type="checkbox" checked={showFavorites} onChange={(e) => setShowFavorites(e.target.checked)} />
          Favorites ({favorites.length})
        </label>
        {!showFavorites && (
          <div className="pagination-inline">
            <button type="button" className="btn btn-sm" disabled={loading || page <= 1} onClick={() => goToPage(page - 1)} title="Previous page">
              ‹
            </button>
            <span className="gb-total">{total != null ? `${total.toLocaleString()} mods · ` : ''}Page</span>
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
            <span>{maxPage ? `of ${maxPage}` : ''}</span>
            <button type="button" className="btn btn-sm" disabled={loading || !hasMore} onClick={() => goToPage(page + 1)} title="Next page (or scroll down)">
              ›
            </button>
          </div>
        )}
      </div>
      {isPortGame && !portName && (
        <p className="message">This game isn't in the emulation library, so Download saves files and shows them in Explorer.</p>
      )}
      {error && <p className="message message-error">{error}</p>}
      {loading && visible.length === 0 ? (
        <div className="empty-state">Loading GameBanana…</div>
      ) : visible.length === 0 ? (
        <div className="empty-state">{showFavorites ? 'No favorites yet — click ♡ on a mod.' : 'No mods here — try another sort, search or game.'}</div>
      ) : (
        <div className={`workshop-browse-grid${showFavorites ? '' : ' grid-fill grid-rows-4'}`} ref={gridRef} onWheel={onWheel}>
          {visible.map((m) => {
            const d = details[m.id];
            const fav = favIds.has(m.id);
            const busy = installing.has(m.id);
            return (
              <article key={m.id} className="mod-card">
                <ModThumbnail remoteUrl={m.previewUrl} title={m.name} />
                <div className="mod-card-body">
                  <h3 className="mod-card-title" title={[m.name, m.category, m.version && `v${m.version}`].filter(Boolean).join('\n')}>
                    {(m.mature || d?.nsfw) && (
                      <span className="pill mature-pill" title="GameBanana marks this mod mature">
                        18+
                      </span>
                    )}
                    {m.name}
                  </h3>
                  <div className="mod-card-meta">
                    <span className="mod-card-line">
                      <span title="Likes on GameBanana">👍 {compact(m.likes)}</span>
                      <span title="Downloads">⬇ {compact(d?.downloads)}</span>
                      <span title="Views">👁 {compact(m.views)}</span>
                      {m.category && <span className="mod-card-author">{m.category}</span>}
                    </span>
                    <span className="mod-card-line" title={`Added ${shortDate(m.added)} · updated ${shortDate(m.updated)}`}>
                      {m.author && <span className="mod-card-author">{m.author}</span>}
                      <span>{shortDate(m.updated ?? m.added)}</span>
                      {m.version && <span>v{m.version}</span>}
                    </span>
                  </div>
                  {d?.description && (
                    <p className="mod-card-desc" title={d.description}>
                      {d.description}
                    </p>
                  )}
                  <div className="mod-card-actions">
                    <button type="button" className={`btn btn-sm${fav ? ' btn-active' : ''}`} title={fav ? 'Favorited (click to remove)' : 'Favorite'} onClick={() => void toggleFavorite(m)}>
                      {fav ? '♥' : '♡'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={busy || !m.hasFiles}
                      title={portName ? `Download, check, and add to ${portName}’s mods (switched on)` : 'Download and check; shown in Explorer'}
                      onClick={() => void install(m)}
                    >
                      {busy ? 'Installing…' : portName ? 'Install' : 'Download'}
                    </button>
                    <button type="button" className="btn btn-sm" title="Open on GameBanana to like or comment (needs your GameBanana login)" onClick={() => void window.modHub.gbOpen(m.url)}>
                      👍 Like ↗
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

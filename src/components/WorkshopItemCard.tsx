import type { WorkshopBrowseItem } from '@shared/types';
import { ModThumbnail } from './ModThumbnail';
import { StarRating } from './StarRating';
import { AuthorLink } from './AuthorLink';
import { formatBytes, formatDate } from '../utils/format';

function compactCount(n?: number): string | undefined {
  if (n == null) return undefined;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

function formatTs(sec?: number) {
  return sec ? formatDate(new Date(sec * 1000).toISOString()) : '—';
}

function shortDate(sec?: number) {
  return sec ? new Date(sec * 1000).toLocaleDateString() : '—';
}

type Props = {
  item: WorkshopBrowseItem;
  installed: boolean;
  favorited: boolean;
  subscribed: boolean;
  installing: boolean;
  onFavorite: () => void;
  onInstall: () => void;
  onSubscribe: () => void;
};

/** A Steam Workshop item that may not be on disk: ModKeeper browse and liked-but-not-installed. */
export function WorkshopItemCard({ item, installed, favorited, subscribed, installing, onFavorite, onInstall, onSubscribe }: Props) {
  const tags = [...(item.gameVersionTags ?? []), ...(item.workshopCategories ?? [])];
  return (
    <article className="mod-card">
      <ModThumbnail remoteUrl={item.previewUrl} title={item.title} />
      <div className="mod-card-body">
        <h3 className="mod-card-title" title={tags.length ? `${item.title}\n${tags.join(', ')}` : item.title}>
          {item.title}
        </h3>
        <div className="mod-card-meta">
          <span className="mod-card-line">
            <span className="mod-card-rating">
              <StarRating score={(item.totalVotes ?? 0) > 0 ? item.starScore : undefined} />
              {(item.totalVotes ?? 0) > 0 && <span className="mod-card-votes">({item.totalVotes!.toLocaleString()})</span>}
            </span>
            {item.lifetimeSubscriptions != null && <span title="Lifetime subscribers">⬇ {compactCount(item.lifetimeSubscriptions)}</span>}
            {item.lifetimeFavorited != null && <span title="Favorited on Steam">♥ {compactCount(item.lifetimeFavorited)}</span>}
          </span>
          <span
            className="mod-card-line"
            title={`Uploaded ${formatTs(item.timeCreated)} · updated ${formatTs(item.timeUpdated)} · ${formatBytes(item.fileSize)}`}
          >
            {item.author && (
              <span className="mod-card-author">
                <AuthorLink author={item.author} steamId={item.authorSteamId} profileUrl={item.authorProfileUrl} />
              </span>
            )}
            <span>{shortDate(item.timeUpdated)}</span>
            <span>{formatBytes(item.fileSize)}</span>
          </span>
        </div>
        {item.description && (
          <p className="mod-card-desc" title={item.description}>
            {item.description}
          </p>
        )}
        <div className="mod-card-actions">
          <button
            type="button"
            className={`btn btn-sm${favorited ? ' btn-active' : ''}`}
            title={favorited ? 'Favorited (click to remove)' : 'Favorite'}
            onClick={onFavorite}
          >
            {favorited ? '♥' : '♡'}
          </button>
          <button
            type="button"
            className={`btn btn-sm btn-primary${installed ? ' btn-active' : ''}`}
            disabled={installed}
            title="Favorite it and install through Steam"
            onClick={onInstall}
          >
            {installed ? 'Installed' : installing ? 'Installing…' : 'Install'}
          </button>
          <button type="button" className={`btn btn-sm${subscribed ? ' btn-active' : ''}`} onClick={onSubscribe}>
            {subscribed ? 'Subscribed' : 'Subscribe'}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            title="Open the Workshop page"
            onClick={() => window.modHub?.steamOpenWorkshop(item.appId, item.workshopId)}
          >
            ↗
          </button>
        </div>
      </div>
    </article>
  );
}

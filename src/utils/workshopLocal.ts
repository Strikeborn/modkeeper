import type { CatalogSnapshot } from '@shared/types';

/** Favorites id for a Workshop item that may not be on disk. */
export function favoriteId(appId: number, workshopId: string) {
  return `ws-${appId}-${workshopId}`;
}

export function localModForWorkshop(catalog: CatalogSnapshot, appId: number, workshopId: string) {
  return catalog.mods.find(
    (m) => m.source === 'steam-workshop' && m.workshopId === workshopId && (m.steamAppId ?? 0) === appId,
  );
}

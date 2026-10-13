import { describe, expect, it } from 'vitest';
import { buildBrowseUrl } from '../electron/workshopBrowse';
import { parseBrowseTags, parseBrowseTotals } from '../electron/workshopBrowsePage';

// Steam embeds its query results as JSON inside a JS string, so quotes arrive as \"
const PAGE =
  String.raw`x\"tags\":[{\"id\":\"1\",\"name\":\"Build 41\",\"display_name\":\"Build 41\",\"admin_only\":false},` +
  String.raw`{\"id\":\"2\",\"name\":\"Staff\",\"display_name\":\"Staff\",\"admin_only\":true},` +
  String.raw`{\"id\":\"3\",\"name\":\"QoL\",\"display_name\":\"QoL\",\"admin_only\":false}],\"x\":1 ` +
  String.raw`{\"eresult\":1,\"current_page\":1,\"total_pages\":1000,\"total_count\":67776,\"results\":[]}`;

describe('Steam browse page', () => {
  it('reads the result count and page count', () => {
    expect(parseBrowseTotals(PAGE)).toEqual({ total: 67776, totalPages: 1000 });
    expect(parseBrowseTotals('nothing')).toEqual({});
  });
  it("reads the game's tags, leaving out admin-only ones", () => {
    expect(parseBrowseTags(PAGE)).toEqual(['Build 41', 'QoL']);
  });
});

describe('buildBrowseUrl', () => {
  const now = Date.UTC(2026, 9, 13);
  it('uses the sort names Steam still accepts', () => {
    const u = new URL(buildBrowseUrl({ appId: 108600, sort: 'subscribed' }, now));
    expect(u.searchParams.get('browsesort')).toBe('totaluniquesubscribers');
    expect(new URL(buildBrowseUrl({ appId: 1, sort: 'updated' }, now)).searchParams.get('browsesort')).toBe('lastupdated');
  });
  it('limits to mods made in the period', () => {
    const u = new URL(buildBrowseUrl({ appId: 108600, sort: 'rated', periodDays: 30 }, now));
    expect(Number(u.searchParams.get('created_date_range_filter_end')) - Number(u.searchParams.get('created_date_range_filter_start'))).toBe(30 * 86400);
    expect(u.searchParams.get('days')).toBeNull();
    expect(new URL(buildBrowseUrl({ appId: 1, sort: 'trend', periodDays: 7 }, now)).searchParams.get('days')).toBe('7');
    expect(new URL(buildBrowseUrl({ appId: 1 }, now)).searchParams.get('created_date_range_filter_start')).toBeNull();
  });
});

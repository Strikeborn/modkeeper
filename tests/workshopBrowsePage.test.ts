import { describe, expect, it } from 'vitest';
import { parseBrowsePageInfo } from '../electron/workshopBrowsePage';

// Steam's browse page embeds item data as JSON inside a JS string, so quotes arrive as \" and escapes doubled.
const page = String.raw`x{\"publishedfileid\":\"111\",\"title\":\"Gravcamp\",\"short_description\":\"A mod that [b]transforms[/b] the camp, don\u0027t worry\",\"workshop_accepted\":false,\"lifetime_subscriptions\":9610,\"lifetime_favorited\":1388,\"star_rating\":5,\"total_votes\":299,\"link_tags\":[]},{\"publishedfileid\":\"222\",\"short_description\":\"Plain\",\"x\":1,\"star_rating\":0,\"total_votes\":0}`;

describe('parseBrowsePageInfo', () => {
  it('reads rating, votes, popularity and a clean description per item', () => {
    const m = parseBrowsePageInfo(page);
    expect(m.get('111')).toEqual({ starRating: 5, totalVotes: 299, subscriptions: 9610, favorited: 1388, description: "A mod that transforms the camp, don't worry" });
    expect(m.get('222')?.totalVotes).toBe(0);
    expect(m.get('222')?.description).toBe('Plain');
  });
});

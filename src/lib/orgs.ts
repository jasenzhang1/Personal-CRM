/**
 * Spotting accounts that are probably not people: clubs, shops, restaurants, schools, brands.
 * Only used to suggest archiving; nothing is archived without you confirming.
 */
import { FIRST_NAMES, looksStandard } from './names';

const ORG_WORDS = new Set(
  `club clubs assoc association society official shop store studio studios company inc llc ltd corp team news magazine mag media records
  music band cafe coffee restaurant eats food foods bakery bar gym fitness yoga university college school dept department center centre
  lab labs foundation org nonprofit church ministry festival fest events tickets app hq global ent entertainment productions gallery
  museum theatre theater agency collective project initiative council committee chapter alumni fraternity sorority dance choir orchestra
  league fc sports athletics brand boutique salon beauty design photography photo photos films tv radio podcast travel hotel resort market
  deals memes daily network community shopping clothing apparel streetwear jewelry cosmetics skincare bakes kitchen grill
  pizza sushi tea boba ramen tacos burger ucla usc ucb ucsd uci ucsb stanford berkeley asu nyu gsrc acm ieee swe shpe nsbe hackathon
  hacks hacker dao capital ventures careers jobs recruiting`
    .split(/\s+/)
    .filter(Boolean),
);
// Words people put in their own usernames too ("anna.ucla", "tom_photo", "amy.travels"): these only
// count when there's no first name in the username.
const LONG_FIRST_NAMES = [...FIRST_NAMES].filter((n) => n.length >= 4);
const SOFT_WORDS = new Set('ucla usc ucb ucsd uci ucsb stanford berkeley asu nyu tea bar photo photos photography tv dance band music design beauty travel fitness yoga eats food daily bakes kitchen boba films art swe acm ieee alumni'.split(' '));

// Longer words that are safe to find inside run-together usernames ("journalclub", "lacoffee").
const SUFFIX_WORDS = [...ORG_WORDS].filter((w) => w.length >= 4 && !['band', 'team', 'dance', 'photo', 'music', 'beauty', 'design'].includes(w));

/** Words in a username or name: "journal.club_la" → ["journal", "club", "la"] */
const tokens = (s: string) => s.toLowerCase().replace(/^@/, '').split(/[^a-z]+/).filter(Boolean);

export function looksLikeOrganization(name: string, usernames: string[] = []): boolean {
  const nameWords = tokens(name);
  const hard = (w: string) => ORG_WORDS.has(w) && !SOFT_WORDS.has(w);
  if (nameWords.some(hard)) return true;
  if (nameWords.length >= 2 && nameWords.every((w) => ORG_WORDS.has(w))) return true; // "UCLA ACM"
  // A proper "First Last" name with no org words is a person.
  if (looksStandard(name) && nameWords.length >= 2) return false;
  for (const u of [name, ...usernames]) {
    if (/\s/.test(u.trim())) continue;
    const ts = tokens(u);
    const personish = ts.some((t) => t.length >= 3 && (FIRST_NAMES.has(t) || LONG_FIRST_NAMES.some((n) => t.startsWith(n) && t.length - n.length <= 10)));
    for (const t of ts) {
      if (hard(t)) return true;
      if (!personish && ORG_WORDS.has(t)) return true;
      if (!personish && t.length >= 7 && SUFFIX_WORDS.some((w) => !SOFT_WORDS.has(w) && (t.endsWith(w) || t.startsWith(w) || (w.length >= 6 && t.includes(w))))) return true;
    }
  }
  return false;
}

// Catalog metadata matching only. Never transliterate or strip all bracketed
// text: language/version qualifiers and subtitles can identify different songs.
export type TrackIdentity = {
  title: string;
  artist: string;
  album?: string;
  duration?: number; // seconds
};
export type CatalogTrack = {
  id: string;
  variants: TrackIdentity[]; // Names from the SAME ID in different storefronts.
  hasLyrics?: boolean;
  hasTimeSyncedLyrics?: boolean;
};
export type RankedTrack = { track: CatalogTrack; score: number; durationDelta?: number };

type ObjectValue = Record<string, unknown>;
// Constructors keep the project's ES2017 TypeScript output target unchanged;
// Unicode property matching runs only in the Node.js route runtime.
const NON_LETTERS = new RegExp("[^\\p{L}\\p{N}]", "gu");
const HANGUL = new RegExp("\\p{Script=Hangul}", "u");
const JAPANESE = new RegExp("[\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Han}]", "u");
const CJK = new RegExp("[\\p{Script=Hangul}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Han}]", "u");
const LATIN = new RegExp("\\p{Script=Latin}", "u");
function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ObjectValue : undefined;
}
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
export function catalogId(value: unknown): string | undefined {
  const id = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : text(value);
  return /^[1-9][0-9]{0,19}$/.test(id) ? id : undefined;
}
export function metadataText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}
function key(value: string): string {
  // Keep every Hangul, kana and Han character. NFKD + removing all combining
  // marks would erase Japanese voicing distinctions (e.g. タ versus ダ).
  return metadataText(value).replace(NON_LETTERS, "");
}
function featureParts(value: string): { base: string; credits: string[] } {
  const original = value.normalize("NFKC");
  const credits: string[] = [];
  const save = (credit: string) => { credits.push(credit.trim()); return " "; };
  const stripped = original
    .replace(/[\[(]\s*(?:feat(?:uring)?\.?|ft\.?)\s+([^\])]+)[\])]/giu,
      (_whole, credit: string) => save(credit))
    .replace(/\s+(?:feat(?:uring)?\.?|ft\.?)\s+(.+)$/iu,
      (_whole, credit: string) => {
        const qualifier = credit.search(/\s[-–—]\s/u);
        if (qualifier < 0) return save(credit);
        save(credit.slice(0, qualifier));
        return ` ${credit.slice(qualifier)}`;
      })
    .replace(/\s+/gu, " ").trim();
  return stripped ? { base: stripped, credits } : { base: original, credits: [] };
}
function titleMatches(request: string, candidate: string): boolean {
  const a = featureParts(request), b = featureParts(candidate);
  if (!key(a.base) || key(a.base) !== key(b.base)) return false;
  // Omitted credits are allowed. Explicitly different guest lists are not.
  if (a.credits.length && b.credits.length) {
    const guests = (items: string[]) => items.flatMap((s) => s.split(/\s*(?:,|&|\band\b)\s*/iu))
      .map(key).filter(Boolean).sort().join("|");
    if (guests(a.credits) !== guests(b.credits)) return false;
  }
  return true;
}
function artistMatches(request: string, candidate: string): boolean {
  // Never split AC/DC, Earth, Wind & Fire, or every '&' into a supposed
  // primary artist. Only explicit featuring credits may be omitted.
  return titleMatches(request, candidate);
}
function bilingualAliasMatches(value: string, aliases: string[]): boolean {
  const parts = featureParts(value).base.match(/^(.+?)\s*[\[(]([^\])]+)[\])]$/u);
  if (!parts) return false;

  const a = parts[1].trim(), b = parts[2].trim();
  if (!((CJK.test(a) && LATIN.test(b) && !CJK.test(b)) ||
        (CJK.test(b) && LATIN.test(a) && !CJK.test(a)))) return false;
  const names = new Set(aliases.map((name) => key(featureParts(name).base)));
  // Both halves must be independently published names of this SAME catalog
  // ID. A literal subtitle cannot be discarded just for looking parenthetic.
  return names.has(key(a)) && names.has(key(b));
}
export function lookupCountries(identity: TrackIdentity): string[] {
  const value = `${identity.title} ${identity.artist} ${identity.album || ""}`;
  const countries: string[] = [];
  if (HANGUL.test(value)) countries.push("kr");
  if (JAPANESE.test(value)) countries.push("jp");
  return countries;
}
export function searchQueries(identity: TrackIdentity): string[] {
  const title = featureParts(identity.title).base;
  const artist = featureParts(identity.artist).base;
  return [...new Set([
    `${identity.title} ${identity.artist}`,
    `${title} ${artist}`,
    title, // Broader retrieval; matching below still REQUIRES the artist.
  ].map((s) => s.trim()).filter(Boolean))];
}
export function parseCatalogResults(payload: unknown, source: "pax" | "itunes"): CatalogTrack[] {
  const root = object(payload);
  if (!root || root.ok === false || !Array.isArray(root.results))
    throw new Error(`invalid ${source} search/lookup response`);
  const tracks: CatalogTrack[] = [];
  for (const item of root.results) {
    const row = object(item);
    if (!row) continue;
    if (source === "itunes" && row.kind !== "song") continue;
    const a = object(row.attributes) || row;
    const id = catalogId(source === "itunes" ? row.trackId : object(a.playParams)?.id || row.id);
    const title = text(source === "itunes" ? row.trackName : a.name);
    const artist = text(a.artistName);
    if (!id || !title || !artist) continue;
    const millis = source === "itunes" ? row.trackTimeMillis : a.durationInMillis;
    const duration = typeof millis === "number" && Number.isFinite(millis) && millis > 0 ? millis / 1000 : undefined;
    tracks.push({ id, variants: [{ title, artist, duration,
      album: text(source === "itunes" ? row.collectionName : a.albumName) || undefined }],
      hasLyrics: typeof a.hasLyrics === "boolean" ? a.hasLyrics : undefined,
      hasTimeSyncedLyrics: typeof a.hasTimeSyncedLyrics === "boolean" ? a.hasTimeSyncedLyrics : undefined });
  }
  return tracks;
}
export function mergeTracks(target: Map<string, CatalogTrack>, tracks: CatalogTrack[], existingOnly = false) {
  for (const track of tracks) {
    const current = target.get(track.id);
    if (!current) {
      if (!existingOnly) target.set(track.id, { ...track, variants: [...track.variants] });
      continue;
    }
    for (const variant of track.variants) {
      if (!current.variants.some((v) => v.title === variant.title && v.artist === variant.artist &&
          v.album === variant.album && v.duration === variant.duration)) current.variants.push(variant);
    }
    current.hasLyrics ??= track.hasLyrics;
    current.hasTimeSyncedLyrics ??= track.hasTimeSyncedLyrics;
  }
}
export function rankTracks(identity: TrackIdentity, tracks: Iterable<CatalogTrack>): RankedTrack[] {
  const ranked: RankedTrack[] = [];
  const requestedDuration = identity.duration || 0;
  const creditKey = (track: TrackIdentity) => {
    const credits = [...featureParts(track.title).credits, ...featureParts(track.artist).credits];
    return [...new Set(credits.flatMap((s) => s.split(/\s*(?:,|&|\band\b)\s*/iu)).map(key).filter(Boolean))].sort().join("|");
  };
  const requestedCredits = creditKey(identity);
  for (const track of tracks) {
    const candidateCredits = track.variants.map(creditKey).filter(Boolean);
    if (requestedCredits && candidateCredits.length && !candidateCredits.includes(requestedCredits)) continue;
    const titleMatch = track.variants.some((v) => titleMatches(identity.title, v.title)) ||
      bilingualAliasMatches(identity.title, track.variants.map((v) => v.title));
    const artistMatch = track.variants.some((v) => artistMatches(identity.artist, v.artist)) ||
      bilingualAliasMatches(identity.artist, track.variants.map((v) => v.artist));
    if (!titleMatch || !artistMatch) continue;
    const durations = track.variants.map((v) => v.duration).filter((n): n is number => n !== undefined);
    const delta = requestedDuration && durations.length
      ? Math.min(...durations.map((n) => Math.abs(n - requestedDuration))) : undefined;
    // Distinct edits/recordings may have the same title. Never bridge a large
    // duration mismatch just because one result claims it has synced lyrics.
    const tolerance = Math.max(2, Math.min(4, (identity.duration || 0) * .01));
    if (delta !== undefined && delta > tolerance) continue;
    const requestedAlbum = identity.album || "";
    const album = requestedAlbum && track.variants.some((v) => v.album && key(v.album) === key(requestedAlbum));
    if (requestedDuration && !durations.length && !album) continue;
    // An omitted feat credit is not enough evidence by itself. Require album
    // or measured duration context before accepting that less exact spelling.
    if (Boolean(requestedCredits) !== Boolean(candidateCredits.length) && !album && delta === undefined) continue;
    const exactTitle = track.variants.some((v) => key(v.title) === key(identity.title));
    const score = 100 + (exactTitle ? 10 : 0) + (album ? 25 : 0) +
      (delta !== undefined ? 20 - delta * 4 : 0) + (track.hasTimeSyncedLyrics ? 2 : 0);
    ranked.push({ track, score, durationDelta: delta });
  }
  return ranked.sort((a, b) => b.score - a.score ||
    (a.durationDelta ?? Infinity) - (b.durationDelta ?? Infinity) || a.track.id.localeCompare(b.track.id));
}

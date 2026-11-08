import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeTracks, parseCatalogResults, rankTracks, searchQueries,
  type CatalogTrack, type TrackIdentity } from "../src/lib/lyrics-match";

const request: TrackIdentity = { title: "A Song", artist: "Singer", album: "Album", duration: 180 };
const track = (id: string, metadata: Partial<TrackIdentity> = {}, synced = true): CatalogTrack =>
  ({ id, variants: [{ ...request, ...metadata }], hasTimeSyncedLyrics: synced });

test("feat suffix omission is accepted while a different guest is rejected", () => {
  assert.equal(rankTracks({ ...request, title: "A Song (feat. Guest)" }, [track("1")]).length, 1);
  assert.equal(rankTracks({ ...request, title: "A Song (feat. Guest)" },
    [track("2", { title: "A Song (feat. Someone Else)" })]).length, 0);
  assert.equal(rankTracks({ ...request, title: "A Song (feat. Guest)" },
    [track("3", { artist: "Singer feat. Someone Else" })]).length, 0);
});
test("literal subtitles and recording/version labels are preserved", () => {
  for (const suffix of ["(You)", "(Live)", "[Acoustic]", "(Japanese Ver.)", "(Remix)", "(Instrumental)"]) {
    assert.equal(rankTracks({ ...request, title: `A Song ${suffix}` }, [track("1")]).length, 0);
    assert.ok(searchQueries({ ...request, title: `A Song ${suffix}` }).every((q) => q.includes(suffix)));
  }
});
test("a version suffix after an unbracketed feature credit is preserved", () => {
  const identity = { ...request, title: "A Song feat. Guest - Live" };
  assert.equal(rankTracks(identity, [track("1")]).length, 0);
  assert.ok(searchQueries(identity).every((q) => q.includes("Live")));
});
test("artist and duration must agree, not merely a lyrics availability flag", () => {
  assert.equal(rankTracks(request, [track("1", { artist: "A Different Singer" })]).length, 0);
  assert.equal(rankTracks(request, [track("2", { duration: 200 })]).length, 0);
  assert.equal(rankTracks(request, [track("3", {}, false)]).length, 1);
});
test("band punctuation is not mistaken for a primary-artist separator", () => {
  assert.equal(rankTracks({ ...request, artist: "AC/DC" }, [track("1", { artist: "AC" })]).length, 0);
  assert.equal(rankTracks({ ...request, artist: "Earth, Wind & Fire" }, [track("2", { artist: "Earth" })]).length, 0);
});
test("Hangul and Japanese voicing distinctions remain meaningful", () => {
  assert.equal(rankTracks({ ...request, title: "가" }, [track("1", { title: "나" })]).length, 0);
  assert.equal(rankTracks({ ...request, title: "ダンス" }, [track("2", { title: "タンス" })]).length, 0);
  assert.equal(rankTracks({ ...request, title: "Ａ Ｓｏｎｇ" }, [track("3")]).length, 1);
});
test("a localized artist alias is valid only when bound to the same catalog ID", () => {
  const target = new Map<string, CatalogTrack>();
  mergeTracks(target, [track("1806264606", { title: "yours", artist: "Damons year", duration: 165.229 })]);
  const identity = { title: "yours", artist: "데이먼스 이어", duration: 165.229 };
  assert.equal(rankTracks(identity, target.values()).length, 0);
  mergeTracks(target, [track("999", identity)], true);
  assert.equal(rankTracks(identity, target.values()).length, 0);
  mergeTracks(target, [track("1806264606", identity)], true);
  assert.equal(rankTracks(identity, target.values())[0]?.track.id, "1806264606");
});
test("bilingual parenthetical names require independent aliases of one ID", () => {
  const candidate = track("1", { title: "Spring Day", artist: "BTS" });
  const identity = { ...request, title: "봄날 (Spring Day)", artist: "BTS" };
  assert.equal(rankTracks(identity, [candidate]).length, 0);
  candidate.variants.push({ ...request, title: "봄날", artist: "BTS" });
  assert.equal(rankTracks(identity, [candidate]).length, 1);
});
test("the intended album and duration rank before an unrelated synced release", () => {
  assert.equal(rankTracks(request, [track("2", { album: "Compilation", duration: 182 }), track("1", {}, false)])[0]?.track.id, "1");
});
test("provider response parsing keeps candidates without synced-lyrics flags", () => {
  const rows = parseCatalogResults({ ok: true, results: [{ name: "A Song", artistName: "Singer",
    durationInMillis: 180000, playParams: { id: "1" } }] }, "pax");
  assert.equal(rankTracks(request, rows).length, 1);
  assert.throws(() => parseCatalogResults({ ok: false, message: "busy" }, "pax"));
});

test("a missing feature credit needs album or duration evidence", () => {
  const unknown = { title: "A Song", artist: "Singer" };
  const featured = { id: "1", variants: [{ title: "A Song (feat. Guest)", artist: "Singer" }] };
  assert.equal(rankTracks(unknown, [featured]).length, 0);
});

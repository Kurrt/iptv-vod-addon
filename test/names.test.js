// Names here are made up from well-known titles, to show the patterns providers use.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeImdb, normalizeTmdb, parseStreamId, rowIds } from '../src/ids.js';
import {
  isPrereleaseCopy, isTruthyFlag, normalizeExtension, normalizeYear, parseLanguage, parseName, resolutionFromName, sanitizeTitle, setExtraProviderTags,
} from '../src/names.js';
import { buildFilename } from '../src/streams.js';

test('imdb accepts tt digits or bare digits, ignores everything else', () => {
  assert.equal(normalizeImdb('tt0111161'), 'tt0111161');
  assert.equal(normalizeImdb(' tt0111161 '), 'tt0111161');
  assert.equal(normalizeImdb('TT0111161'), 'tt0111161');
  assert.equal(normalizeImdb('0111161'), 'tt0111161');
  assert.equal(normalizeImdb(111161), 'tt111161');
  for (const bad of ['', '0', 0, 'tt', 'tt0', 'tm123', 'imdb:tt1', 'tt12a', null, undefined, {}, [], 1.5, -3, true]) {
    assert.equal(normalizeImdb(bad), null, String(bad));
  }
});

test('tmdb accepts digits only', () => {
  assert.equal(normalizeTmdb('603'), '603');
  assert.equal(normalizeTmdb(603), '603');
  assert.equal(normalizeTmdb(' 603 '), '603');
  // 'tm123' is the pass-through value Dispatcharr's own test fixture uses.
  for (const bad of ['', '0', 0, 'tm123', 'tt603', '60.3', null, undefined, {}, [], 1.5, -3, false]) {
    assert.equal(normalizeTmdb(bad), null, String(bad));
  }
});

test('a bare imdb value equal to tmdb_id is dropped rather than invented into an IMDb id', () => {
  assert.deepEqual(rowIds({ tmdb_id: '1234567', imdb_id: '1234567' }), { tmdb: '1234567', imdb: null });
  assert.deepEqual(rowIds({ tmdb_id: '1234567', imdb_id: 'tt1234567' }), { tmdb: '1234567', imdb: 'tt1234567' });
  assert.deepEqual(rowIds({ tmdb_id: '', imdb_id: '1234567' }), { tmdb: null, imdb: 'tt1234567' });
});

test('stream ids route on shape', () => {
  assert.deepEqual(parseStreamId('tt123'), { kind: 'movie', ns: 'tt', key: 'tt123' });
  assert.deepEqual(parseStreamId('tmdb:55'), { kind: 'movie', ns: 'tmdb', key: '55' });
  assert.deepEqual(parseStreamId('tt123:1:2'), { kind: 'episode', ns: 'tt', key: 'tt123', season: 1, episode: 2 });
  assert.deepEqual(parseStreamId('tmdb:55:0:3'), { kind: 'episode', ns: 'tmdb', key: '55', season: 0, episode: 3 });
  assert.deepEqual(parseStreamId('tt123:01:02'), { kind: 'episode', ns: 'tt', key: 'tt123', season: 1, episode: 2 });
  for (const id of [
    'tt123:1', 'tt123:1:2:3', 'tt', 'TT123', 'kitsu:1', 'foo', '', '123', 'tt123:a:b',
    'tmdb:', 'tmdb:abc', 'tmdb:55:1', 'tmdb:55:1:2:3',
  ]) {
    assert.deepEqual(parseStreamId(id), { kind: 'invalid' }, id);
  }
});

test('language comes from the trailing [XX] suffix only', () => {
  assert.equal(parseLanguage('Movie [EN]'), 'EN');
  assert.equal(parseLanguage('Movie [en]  '), 'EN');
  assert.equal(parseLanguage('Movie [FR] [EN]'), 'EN');
  assert.equal(parseLanguage('Movie'), null);
  assert.equal(parseLanguage('[EN] Movie'), null);
  assert.equal(parseLanguage('Movie [ENG]'), null);
  assert.equal(parseLanguage(null), null);
});

test('quality tags that fit the [XX] pattern are not languages', () => {
  for (const name of ['Film [HD]', 'Film [hd]', 'Film [SD]', 'Film [TV]', 'Film [CC]', 'Film [HD] [SD]']) {
    assert.equal(parseLanguage(name), null, name);
  }
  // Whatever else fits the pattern is still a language, as Dispatcharr writes them.
  assert.equal(parseLanguage('Film [XX]'), 'XX');
  // A real tag is found on either side of a quality tag.
  assert.equal(parseLanguage('Film [HD] [EN]'), 'EN');
  assert.equal(parseLanguage('Film [FR] [HD]'), 'FR');
  assert.equal(parseLanguage('Film [FR] [HD] [SD]'), 'FR');

  // Only the language tag leaves the title.
  assert.equal(sanitizeTitle('Film [HD]'), 'Film [HD]');
  assert.equal(sanitizeTitle('Film [HD] [EN]'), 'Film [HD]');
  assert.equal(sanitizeTitle('Film [EN] [HD]'), 'Film [HD]');
  assert.equal(sanitizeTitle('Film [FR] [HD] [SD]'), 'Film [HD] [SD]');
});

test('titles lose path separators, control characters and the language suffix', () => {
  assert.equal(sanitizeTitle('Face/Off [EN]'), 'Face Off');
  assert.equal(sanitizeTitle('a\\b/c'), 'a b c');
  assert.equal(sanitizeTitle(`Evil\u0000 Name\r\nInjected${String.fromCodePoint(0x2028)}Here`), 'Evil Name Injected Here');
  assert.equal(sanitizeTitle('../../etc/passwd'), 'etc passwd');
  assert.equal(sanitizeTitle('Movie [FR] [EN]'), 'Movie [FR]');
  assert.equal(sanitizeTitle('...'), 'Unknown');
  assert.equal(sanitizeTitle(null), 'Unknown');
  assert.ok(sanitizeTitle('x'.repeat(1000)).length <= 160);
});

test('titles are cut on a character boundary and always well formed', () => {
  // An emoji straddling the limit goes whole.
  assert.equal(sanitizeTitle(`${'a'.repeat(159)}\u{1F3AC} tail`), 'a'.repeat(159));
  // One that fits stays whole.
  const fits = `${'a'.repeat(158)}\u{1F3AC}`;
  assert.equal(sanitizeTitle(`${fits} tail`), fits);
  // Unpaired surrogates a provider sent are replaced rather than passed on.
  assert.equal(sanitizeTitle('Film \ud83d name'), 'Film � name');
  assert.equal(sanitizeTitle('Film \ude00 name'), 'Film � name');
  // A cut never leaves a trailing dot or space behind.
  assert.equal(sanitizeTitle(`${'a'.repeat(159)}. tail`), 'a'.repeat(159));
});

test('extensions are validated and default like Dispatcharr', () => {
  assert.equal(normalizeExtension('mkv'), 'mkv');
  assert.equal(normalizeExtension('.MKV'), 'mkv');
  for (const bad of ['', null, undefined, 42, 'mk v', 'mkv/../x', 'waytoolongext']) {
    assert.equal(normalizeExtension(bad), 'mp4', String(bad));
  }
});

test('year comes from the first usable candidate', () => {
  assert.equal(normalizeYear(1999), 1999);
  assert.equal(normalizeYear('', '2022-06-01'), 2022);
  assert.equal(normalizeYear('', '', '2015'), 2015);
  assert.equal(normalizeYear('', null, undefined), null);
  assert.equal(normalizeYear('20201'), null);
  assert.equal(normalizeYear('0000'), null);
});

test('is_adult flag handles the forms a pass-through value could take', () => {
  for (const yes of [1, true, '1', 'true']) assert.equal(isTruthyFlag(yes), true, String(yes));
  for (const no of [0, false, '0', '', 'false', null, undefined]) assert.equal(isTruthyFlag(no), false, String(no));
});

test('resolution is read only when the name clearly carries one', () => {
  const cases = [
    ['Movie 2160p', '2160p'],
    ['Movie 4K', '2160p'],
    ['Movie [4K]', '2160p'],
    ['Movie.4k.mkv', '2160p'],
    ['Movie UHD', '2160p'],
    ['Movie 1440p', '1440p'],
    ['Movie 1080p', '1080p'],
    ['Movie 1080P', '1080p'],
    ['Movie FHD', '1080p'],
    ['Movie 1080i', '1080p'],
    ['Movie 1080p60', '1080p'],
    ['Movie 720p', '720p'],
    ['Movie 576p', '576p'],
    ['Movie 480p', '480p'],
    ['Movie (480P)', '480p'],
    ['Movie 360p', '360p'],
    // Heights that are not the usual ones, from cropped encodes.
    ['Heat (1995) AL PACINO 464P', '480p'],
    ['Inception.2010.2122p.MAX.WEB-DL', '2160p'],
    // SD only in a form that cannot be a word.
    ['Film (SD)', '480p'],
    ['Film [SD]', '480p'],
    ['Film (SD) (1983)', '480p'],
    ['Alien (1979) SD', '480p'],
    ['Alien - 1979 SD', '480p'],
    ['Le Samourai (1967) ALAIN DELON (FRENCH ENG-SUB) SD', '480p'],
    // A marker in a provider prefix counts, because this reads the raw name.
    ['4K-NF - The Irishman (2019)', '2160p'],
    ['EN -4k Alien - 1979', '2160p'],
    ['AMZ - 4K-Arrival (2016)', '2160p'],
    // Lowest wins: a 1080p encode of a UHD source.
    ['The Martian UHD BluRay 1080p', '1080p'],
    // Dimensions by width class, because films are cropped.
    ['Film [1920x800]', '1080p'],
    ['Film 1280x536', '720p'],
    ['Film 3840x1600', '2160p'],
    // None of these say anything about the resolution.
    ['Movie', null],
    ['Movie HD', null],
    ['Movie SD', null],
    ['SD Gundam Force', null],
    ['Y2K', null],
    ['Blade Runner 2049', null],
    ['Apollo 13', null],
    ['The 1080 Club', null],
    ['Show 2x10', null],
    ['Movie 4K Restored', null],
    ['Movie 4K Remastered', null],
    ['Area 300p', null],
    [null, null],
  ];
  for (const [name, expected] of cases) assert.equal(resolutionFromName(name), expected, String(name));
});

// The filename, built the way a stream is, with the default fallback tag.
function filename(name, { year = null, language = null, ext = 'mkv', episode = null, fallback = '1080p' } = {}) {
  const parsed = parseName(name, { year, language, series: episode !== null });
  return buildFilename(parsed, parsed.resolution ?? fallback, episode, ext);
}

test('names in the shapes providers use become clean filenames', () => {
  const cases = [
    // Prefixes, with the 4K signal in one carried to the resolution token.
    ['4K-NF - The Irishman (2019)', { year: 2019 }, 'The Irishman (2019) 2160p.mkv'],
    ['09 EN - The Matrix', { ext: 'mp4' }, 'The Matrix 1080p ENG.mp4'],
    ['D+ - Moana (GB)', { ext: 'mp4' }, 'Moana 1080p.mp4'],
    ['NF - Roma (MX)', {}, 'Roma 1080p.mkv'],
    ['EN - Alien - 1979', { year: 1979, ext: 'ts' }, 'Alien (1979) 1080p ENG'],
    ['EN - Psycho 4K (1960)', { year: 1960, ext: 'mp4' }, 'Psycho (1960) 2160p ENG.mp4'],
    ['EN - Amelie (2001) AUDREY TAUTOU (FRENCH ENG-SUB)', { year: 2001 }, 'Amelie (2001) 1080p FRENCH ENG-SUB.mkv'],
    ['HBO - Some Doc (2020)', { year: 2020 }, 'Some Doc (2020) 1080p.mkv'],
    ['AMZ - A Film (2020)', { year: 2020 }, 'A Film (2020) 1080p.mkv'],
    ['NF - Okja (2017) (KR)', { year: 2017 }, 'Okja (2017) 1080p.mkv'],
    ['NF - AR - Inception', { year: 2010 }, 'Inception (2010) 1080p.mkv'],
    // Doubled and odd prefixes.
    ['EN - EN - Il Postino (1994) (ITALIAN ENG-SUB)', { year: 1994 }, 'Il Postino (1994) 1080p ITALIAN ENG-SUB.mkv'],
    ['EN -4k EN - Blade Runner 4K (1982)', { year: 1982 }, 'Blade Runner (1982) 2160p ENG.mkv'],
    ['EN -4k Alien - 1979', { year: 1979 }, 'Alien (1979) 2160p ENG.mkv'],
    ['FR -4K 4K Amelie (2001)', { year: 2001 }, 'Amelie (2001) 2160p.mkv'],
    ['AMZ - 4K-Arrival (2016)', { year: 2016 }, 'Arrival (2016) 2160p.mkv'],
    // Real titles with a hyphen or a dash keep it.
    ['X-Men', { year: 2000 }, 'X-Men (2000) 1080p.mkv'],
    ['Spider-Man: Homecoming', { year: 2017 }, 'Spider-Man: Homecoming (2017) 1080p.mkv'],
    ['EN - X-Men: First Class (2011)', { year: 2011 }, 'X-Men: First Class (2011) 1080p ENG.mkv'],
    ['Thor - Love and Thunder', {}, 'Thor - Love and Thunder 1080p.mkv'],
    ['SAS - Rogue Heroes', { year: 2022 }, 'SAS - Rogue Heroes (2022) 1080p.mkv'],
    ['Heat - 1995', { year: 1995 }, 'Heat (1995) 1080p.mkv'],
    ['EN - Rogue One - A Star Wars Story - 2016', { year: 2016 }, 'Rogue One - A Star Wars Story (2016) 1080p ENG.mkv'],
    ['Film - 1984 Revisited', { year: 2019 }, 'Film - 1984 Revisited (2019) 1080p.mkv'],
    // Lowercase look-alikes of a tag are titles: the list is case-sensitive.
    ['Nf - Roma (2018)', { year: 2018 }, 'Nf - Roma (2018) 1080p.mkv'],
    // Year handling.
    ['2012', { year: 2009 }, '2012 (2009) 1080p.mkv'],
    ['HBO - 2012 (2009)', { year: 2009 }, '2012 (2009) 1080p.mkv'],
    ['2012', { year: 2012 }, '2012 (2012) 1080p.mkv'],
    ['Blade Runner 2049', { year: 2017 }, 'Blade Runner 2049 (2017) 1080p.mkv'],
    ['EN - Heat 1995', { year: 1995 }, 'Heat (1995) 1080p ENG.mkv'],
    ['Jaws, 1975', { year: 1975 }, 'Jaws (1975) 1080p.mkv'],
    ['NF - Okja (-2017)', {}, 'Okja (2017) 1080p.mkv'],
    ['EN - Friends (1994-2004)', {}, 'Friends (1994) 1080p ENG.mkv'],
    ['EN - Monday Night Football (15 07 2024)', {}, 'Monday Night Football (15 07 2024) 1080p ENG.mkv'],
    ['HBO - (500) Days of Summer (2009)', { year: 2009 }, '(500) Days of Summer (2009) 1080p.mkv'],
    // What can follow a dash year.
    ['EN - Alien - 1979_eng', {}, 'Alien (1979) 1080p ENG.mkv'],
    ['EN - Parasite - 2019 SUB', {}, 'Parasite (2019) 1080p ENG.mkv'],
    ['EN - Dune: Part Two - 2024 ESUB', {}, 'Dune: Part Two (2024) 1080p ENG.mkv'],
    ['EN - Mad Max: Fury Road - 2015 4K', { year: 2015 }, 'Mad Max: Fury Road (2015) 2160p ENG.mkv'],
    ['EN - Alien - 1979 SD', { year: 1979 }, 'Alien (1979) 480p ENG.mkv'],
    // Residue after the year goes, and quality, codec and language words stay.
    ['EN - Chinatown 4K (1974) JACK NICHOLSON', { year: 1974 }, 'Chinatown (1974) 2160p ENG.mkv'],
    ['EN - Heat (1995) AL PACINO 464P', { year: 1995 }, 'Heat (1995) 480p ENG.mkv'],
    ['Roma - A Family Story (2018) MX', { year: 2018 }, 'Roma - A Family Story (2018) 1080p.mkv'],
    ['NF - Kramer vs. Kramer (1979) HEVC', { year: 1979 }, 'Kramer vs. Kramer (1979) 1080p HEVC.mkv'],
    ['EN - Les Miserables (SD) (1958) (FRENCH ONLY NO SUB) JEAN GABIN', { year: 1958 }, 'Les Miserables (1958) 480p FRENCH ONLY NO SUB.mkv'],
    ['EN - The Addams Family (1991) (480P)', { year: 1991 }, 'The Addams Family (1991) 480p ENG.mkv'],
    // A country in brackets is not a language, whatever two letters it uses.
    ['4K-AMZ - The Intouchables (Intouchables) (2011) (FR)', { year: 2011 }, 'The Intouchables (Intouchables) (2011) 2160p.mkv'],
    // Release-format names, the ones that really state a quality.
    ['NF - Napoleon.The.Directors.Cut.2023.2160p.ATVP.WEB-DL.DDP5.1.Atmos.H.265-', {}, 'Napoleon The Directors Cut (2023) 2160p WEB-DL H.265.mkv'],
    ['AMZ - Arrival.2016.2016.1080p.AMZN.WEB-DL.AAC2.0.H.264-NOGRP', {}, 'Arrival (2016) 1080p WEB-DL H.264.mkv'],
    ['EN - Amelie.2001.FRENCH.1080p.WEB-DL.H264-NOGRP', {}, 'Amelie (2001) 1080p WEB-DL H264 FRENCH.mkv'],
    ['EN - Rashomon.1950.720p.BluRay.x264.AAC-[NOGRP]', {}, 'Rashomon (1950) 720p BluRay x264 ENG.mkv'],
    ['EN - The Matrix 1999 720p WEB-DL x264 NOGRP', {}, 'The Matrix (1999) 720p WEB-DL x264 ENG.mkv'],
    ['the.martian.2015.1080p.web.h264-nogrp', {}, 'the martian (2015) 1080p web h264.mkv'],
    ['D+ - X2.2003.2160p.DSNP.WEB-DL', {}, 'X2 (2003) 2160p WEB-DL.mkv'],
    // A bare "web" and a title's IMAX or dots are not technical, and scan notes are not resolutions.
    ['EN - IMAX Everest (1998)', { year: 1998 }, 'IMAX Everest (1998) 1080p ENG.mkv'],
    ["Charlotte's Web", { year: 1973 }, "Charlotte's Web (1973) 1080p.mkv"],
    ['E.T.', { year: 1982 }, 'E.T. (1982) 1080p.mkv'],
    ['Movie 4K Restored (1980)', { year: 1980 }, 'Movie Restored (1980) 1080p.mkv'],
    ['Studio 1080internal', { year: 2000 }, 'Studio 1080internal (2000) 1080p.mkv'],
    ['Film 1080i', { year: 2000 }, 'Film (2000) 1080p.mkv'],
    // Nothing left to call it.
    ['EN - (1999)', {}, 'Unknown (1999) 1080p ENG.mkv'],
    ['', {}, 'Unknown 1080p.mkv'],
  ];
  for (const [name, options, expected] of cases) assert.equal(filename(name, options), expected, name);
});

test('an unlisted tag stays in the title, and the name still parses', () => {
  assert.equal(filename('XY - Alien (1979)', { year: 1979 }), 'XY - Alien (1979) 1080p.mkv');
  assert.equal(filename('4K-XY - Alien (1979)', { year: 1979 }), 'XY - Alien (1979) 2160p.mkv');
});

test('English comes from an EN tag or a [EN] suffix, and only when no other language is stated', () => {
  const languages = (name, language = null) => parseName(name, { language }).languages;
  assert.deepEqual(languages('EN - Film'), ['ENG']);
  assert.deepEqual(languages('09 EN - Film'), ['ENG']);
  assert.deepEqual(languages('4K-EN - Film'), ['ENG']);
  assert.deepEqual(languages('Film', 'EN'), ['ENG']);
  assert.deepEqual(languages('EN - Film', 'EN'), ['ENG']);
  // Exactly EN: these are other tags.
  assert.deepEqual(languages('NF - Film'), []);
  assert.deepEqual(languages('EN-XY - Film'), []);
  assert.deepEqual(languages('XEN - Film'), []);
  assert.deepEqual(languages('Nf - Film'), []);
  // A stated language wins, so French-only is not read as English.
  assert.deepEqual(languages('EN - Film (2000) (FRENCH ONLY)'), ['FRENCH ONLY']);
  assert.deepEqual(languages('EN - Film (FRENCH ENG-SUB)'), ['FRENCH ENG-SUB']);
  assert.deepEqual(languages('EN - Film', 'FR'), ['FR']);
  assert.deepEqual(languages('Film', 'FR'), ['FR']);
  // Brackets that only look like a language.
  assert.deepEqual(languages('Film (IT)'), []);
  assert.deepEqual(languages('EN - Film (2019) (FR EXTRAS)'), ['ENG']);
  // Bare language words stay title words, except in a release-format name.
  assert.deepEqual(languages('The French Connection (1971)'), []);
  assert.deepEqual(languages('Film.2024.1080p.FRENCH.WEB-DL'), ['FRENCH']);
});

test('the near-miss forms of the common tags are prefixes too', () => {
  const cases = [
    ['EN- Shrek (2001)', { year: 2001 }, 'Shrek (2001) 1080p ENG.mkv'],
    ['EN- Hamlet (1996)', { year: 1996 }, 'Hamlet (1996) 1080p ENG.mkv'],
    ['EN- Friday (1995) ICE CUBE', { year: 1995 }, 'Friday (1995) 1080p ENG.mkv'],
    ['EN- Juno (2007)', { year: 2007 }, 'Juno (2007) 1080p ENG.mkv'],
    ['EN- Star Wars: A New Hope (1977)', { year: 1977 }, 'Star Wars: A New Hope (1977) 1080p ENG.mkv'],
    ['EN: The Godfather (1972) (US)', { year: 1972 }, 'The Godfather (1972) 1080p ENG.mkv'],
    ['EN: Amélie (2001) (FR)', { year: 2001 }, 'Amélie (2001) 1080p ENG.mkv'],
    ['EN: Spirited Away (Sen to Chihiro) (2001) (JP)', { year: 2001 }, 'Spirited Away (Sen to Chihiro) (2001) 1080p ENG.mkv'],
    ['En - Blade Runner: Director\'s Cut (1982)', { year: 1982 }, 'Blade Runner: Director\'s Cut (1982) 1080p ENG.mkv'],
    ['EN Le Fabuleux Destin (2001) (FRENCH ENG-SUB) AUDREY TAUTOU', { year: 2001 }, 'Le Fabuleux Destin (2001) 1080p FRENCH ENG-SUB.mkv'],
    ['NF: Stranger Things: Season One', { year: 2016 }, 'Stranger Things: Season One (2016) 1080p.mkv'],
    ['NF + Roma (2018)', { year: 2018 }, 'Roma (2018) 1080p.mkv'],
  ];
  for (const [name, options, expected] of cases) assert.equal(filename(name, options), expected, name);

  // Still closed and case-sensitive. These are not tags, or not separators.
  const titles = [
    ['En: Film (2001)', 2001, 'En: Film (2001) 1080p.mkv'],
    ['Nf: Film (2001)', 2001, 'Nf: Film (2001) 1080p.mkv'],
    ['EN GARDE (2004)', 2004, 'EN GARDE (2004) 1080p.mkv'],
    ['ENCORE: Film (2004)', 2004, 'ENCORE: Film (2004) 1080p.mkv'],
    ['XX: Film (2004)', 2004, 'XX: Film (2004) 1080p.mkv'],
    ['Spider-Man: Homecoming (2017)', 2017, 'Spider-Man: Homecoming (2017) 1080p.mkv'],
  ];
  for (const [name, year, expected] of titles) assert.equal(filename(name, { year }), expected, name);
});

test('extra tags join the list: matched literally, case-sensitive, and only as a prefix', (t) => {
  t.after(() => setExtraProviderTags([]));
  const title = (name) => parseName(name).title;
  assert.equal(title('ABC - Film'), 'ABC - Film');
  setExtraProviderTags(['ABC', 'X+', 'A.B', 'EN-XY', '(Q)']);
  assert.equal(title('ABC - Film'), 'Film');
  assert.equal(title('X+ - Film'), 'Film');
  assert.equal(title('A.B - Film'), 'Film');
  assert.equal(title('EN-XY - Film'), 'Film');
  assert.equal(title('(Q) - Film'), 'Film');
  // The list number and 4K marker still come first, and the built-in tags still work.
  assert.equal(title('09 ABC - Film'), 'Film');
  assert.equal(title('4K-ABC - Film'), 'Film');
  assert.equal(title('NF - Film'), 'Film');
  // Not a regular expression, not another case, and not the middle of a title.
  assert.equal(title('XX - Film'), 'XX - Film');
  assert.equal(title('AxB - Film'), 'AxB - Film');
  assert.equal(title('Abc - Film'), 'Abc - Film');
  assert.equal(title('The ABC - Film'), 'The ABC - Film');
  // An extra tag says nothing about the language.
  assert.deepEqual(parseName('ABC - Film').languages, []);
});

test('a title can really open with a number and a dot', () => {
  assert.equal(filename('AMZ - 12.Angry.Men.1957', { year: 1957 }), '12 Angry Men (1957) 1080p.mkv');
  assert.equal(filename('NF - 9. Film (2020)', { year: 2020 }), '9. Film (2020) 1080p.mkv');
});

test('a number ending the title stays when the name marks its year separately', () => {
  const cases = [
    ['NF - Goodbye 2020 (2020)', 2020, 'Goodbye 2020 (2020) 1080p.mkv'],
    ['HBO - Dracula 2000 (2000)', 2000, 'Dracula 2000 (2000) 1080p.mkv'],
    ['HBO - Dracula A.D. 1972 (1972)', 1972, 'Dracula A.D. 1972 (1972) 1080p.mkv'],
    ['EN - Broadway Melody Of 1940 (1940)', 1940, 'Broadway Melody Of 1940 (1940) 1080p ENG.mkv'],
    ['EN - Gold Diggers of 1933 - 1933', 1933, 'Gold Diggers of 1933 (1933) 1080p ENG.mkv'],
    ['WrestleMania 2000 (2000)', 2000, 'WrestleMania 2000 (2000) 1080p.mkv'],
    ['EN - Mad Max 1979 - 1979', 1979, 'Mad Max 1979 (1979) 1080p ENG.mkv'],
  ];
  for (const [name, year, expected] of cases) assert.equal(filename(name, { year }), expected, name);
  // With no such marker it is still the year, because nothing else in the name is.
  assert.equal(filename('EN - Heat 1995', { year: 1995 }), 'Heat (1995) 1080p ENG.mkv');
  // And release names do repeat it.
  assert.equal(filename('Film.2019.1080p.WEB-DL (2019)', { year: 2019 }), 'Film (2019) 1080p WEB-DL.mkv');
});

test('the year: the row, unless it came from the title or a film\'s name disagrees', () => {
  const read = (name, year, series = false) => {
    const parsed = parseName(name, { year, series });
    return [parsed.year, parsed.yearConflict];
  };
  // Agreeing, or within one year, which releases often are: the row.
  assert.deepEqual(read('EN - Film (2020)', 2020), [2020, false]);
  assert.deepEqual(read('EN - Film (2019)', 2020), [2020, false]);
  assert.deepEqual(read('EN - Film (2021)', 2020), [2020, false]);
  // Only one of them: that one.
  assert.deepEqual(read('EN - Film', 2020), [2020, false]);
  assert.deepEqual(read('EN - Film (2020)', null), [2020, false]);
  assert.deepEqual(read('EN - Film', null), [null, false]);

  // The row's year is a word of the title, which is Dispatcharr's fallback when a
  // provider sends none. The name's is the real one, and nothing disagrees.
  assert.deepEqual(read('EN - 1917 (2019)', 1917), [2019, false]);
  assert.deepEqual(read('EN - 1941 - 1979', 1941), [1979, false]);
  assert.deepEqual(read('EN - 2012 - 2009', 2012), [2009, false]);
  assert.deepEqual(read('EN - 2001: A Space Odyssey - 1968', 2001), [1968, false]);
  assert.deepEqual(read('EN - Fantasia 2000 (1999) MICKEY MOUSE', 2000), [1999, false]);
  assert.equal(filename('EN - Fantasia 2000 (1999)', { year: 2000 }), 'Fantasia 2000 (1999) 1080p ENG.mkv');
  // With no other year in the name, the row's is all there is.
  assert.deepEqual(read('2012', 2012), [2012, false]);
  // Inside a longer number or word it is not the title's.
  assert.deepEqual(read('EN - Y2012K (2015)', 2012), [2015, true]);

  // A film whose name disagrees: the name's year, so a year filter can see it. These
  // rows' ids read as an older title of the same name.
  assert.deepEqual(read('EN - Dune (2021) DENIS VILLENEUVE', 1984), [2021, true]);
  assert.deepEqual(read('EN - Psycho (1998)', 1960), [1998, true]);
  assert.deepEqual(read('EN - The Thing (2011)', 1982), [2011, true]);
  assert.deepEqual(read('EN - Scarface (1983) (DOC) AL PACINO', 1932), [1983, true]);
  assert.deepEqual(read('EN - The Italian Job (2003)', 1969), [2003, true]);
  assert.equal(filename('EN - Dune (2021) DENIS VILLENEUVE', { year: 1984 }), 'Dune (2021) 1080p ENG.mkv');
  // The same rule happens to correct a row that is simply wrong.
  assert.deepEqual(read('NF - Roma (2018)', 2008), [2018, true]);
  assert.deepEqual(read('EN - 2012 (2009)', 2019), [2009, true]);
  // A release-format name states a year as well.
  assert.deepEqual(read('Film.2018.1080p.WEB-DL', 2021), [2018, true]);

  // A range covering the row is no conflict for either kind.
  assert.deepEqual(read('EN - Friends (1994-2004)', 1996), [1996, false]);
  assert.deepEqual(read('EN - The Simpsons (1989-2020)', 1991, true), [1991, false]);
  assert.deepEqual(read('EN - Seinfeld (1989-1998)', 1994, true), [1994, false]);
  assert.deepEqual(read('EN - Frasier (1993-1004)', 1993, true), [1993, false]);
  assert.deepEqual(read('EN - Show (2015-)', 2020, true), [2020, false]);

  // A show spans years, so its name may state a later season or a revival. The row's
  // year stays, and the row is counted.
  assert.deepEqual(read('EN - Doctor Who (2005)', 1963, true), [1963, true]);
  assert.deepEqual(read('NICK - iCarly (2021)', 2007, true), [2007, true]);
  assert.deepEqual(read('EN - Show (1980-1990)', 2005, true), [2005, true]);
  // A year from the title is as wrong for a show as for a film.
  assert.deepEqual(read('EN - 1883 (2021)', 1883, true), [2021, false]);
});

test('a bracket closing on SUB, SUBS or ONLY is a language, so ENG is not added to it', () => {
  const cases = [
    // Stating no English at all: these must not pass an English requirement.
    ['EN - Le Samourai (1967) (FRNCH ONLY) ALAIN DELON', 1967, 'Le Samourai (1967) 1080p FRNCH ONLY.mkv'],
    ['EN - Amelie (2001.) (FRENCH & RUSSIAN ONLY)', 2001, 'Amelie (2001) 1080p FRENCH RUSSIAN ONLY.mkv'],
    ['EN - Parasite (2019) (SWAHILI MULTI SUB)', 2019, 'Parasite (2019) 1080p SWAHILI MULTI SUB.mkv'],
    ['EN - Let the Right One In (2008) (RURITANIAN MULTI-SUB)', 2008, 'Let the Right One In (2008) 1080p RURITANIAN MULTI-SUB.mkv'],
    ["EN - La Vie d'Adèle, Blue Is the Warmest Colour (2013) (FRENCH MULTY SUB)", 2013, "La Vie d'Adèle, Blue Is the Warmest Colour (2013) 1080p FRENCH MULTY SUB.mkv"],
    ['EN - District 9 (2009) (FREEDONIAN MULTI SUB)', 2010, 'District 9 (2010) 1080p FREEDONIAN MULTI SUB.mkv'],
    // Keeping the stated language alongside the English subtitles.
    ['EN - Waltz with Bashir (2008) (HEBREW ENG-SUB)', 2008, 'Waltz with Bashir (2008) 1080p HEBREW ENG-SUB.mkv'],
    ['EN - Stalker (1979) (SYLDAVIAN ENG-SUB)', 1979, 'Stalker (1979) 1080p SYLDAVIAN ENG-SUB.mkv'],
    ['EN - Wadjda (2012) (BORDURIAN ENG & FR SUB)', 2012, 'Wadjda (2012) 1080p BORDURIAN ENG FR SUB.mkv'],
    ['EN - Whale Rider (2002) (New Ruritania ENG-SUB)', 2002, 'Whale Rider (2002) 1080p New Ruritania ENG-SUB.mkv'],
    // Never closed, whatever the provider ended it with.
    ['EN - Hero, Ying Xiong (2002) Jet Li (CHINESE ENG-SUB', 2002, 'Hero, Ying Xiong (2002) 1080p CHINESE ENG-SUB.mkv'],
    ['EN - La Haine, Hate (1995) (FRENCH ENG-SUB', 1995, 'La Haine, Hate (1995) 1080p FRENCH ENG-SUB.mkv'],
    ["EN - Amelie's Paris - Le Fabuleux (2001) (FRENCH ENG-SUB_", 2001, "Amelie's Paris - Le Fabuleux (2001) 1080p FRENCH ENG-SUB.mkv"],
    ["EN - Pan's Labyrinth (2006) (SPANISH ENG-SUB(", 2006, "Pan's Labyrinth (2006) 1080p SPANISH ENG-SUB.mkv"],
    // In the title part it leaves the title.
    ['EN - Film (FRENCH & RUSSIAN ONLY)', 2020, 'Film (2020) 1080p FRENCH RUSSIAN ONLY.mkv'],
    ['EN - Film (FRENCH ENG-SUB', 2020, 'Film (2020) 1080p FRENCH ENG-SUB.mkv'],
  ];
  for (const [name, year, expected] of cases) assert.equal(filename(name, { year }), expected, name);

  const languages = (name) => parseName(name).languages;
  for (const word of ['HEBREW', 'BULGARIAN', 'LATVIAN', 'LITHUANIAN', 'SLOVENIAN', 'VIETNAMESE', 'MALAY', 'PUNJABI', 'SERBIAN', 'CROATIAN', 'ESTONIAN', 'INDONESIAN', 'BENGALI', 'MARATHI', 'GUJARATI', 'KANNADA', 'MALAYALAM', 'LATINO']) {
    assert.deepEqual(languages(`EN - Film (2020) (${word})`), [word], word);
    assert.deepEqual(languages(`Film.2020.1080p.${word}.WEB-DL`), [word], word);
  }

  // Titles that only end like one. Case is what tells them apart.
  assert.equal(filename('Film (Members Only) (2000)', { year: 2000 }), 'Film (Members Only) (2000) 1080p.mkv');
  assert.equal(filename('Film (game only) (2000)', { year: 2000 }), 'Film (game only) (2000) 1080p.mkv');
  assert.equal(filename('Film (The Sub) (2000)', { year: 2000 }), 'Film (The Sub) (2000) 1080p.mkv');
  // And a bracket that is not a language still does not stop ENG.
  assert.deepEqual(languages('EN - Film (2019) (DOC)'), ['ENG']);
  assert.deepEqual(languages('EN - Film (2019) (FR EXTRAS)'), ['ENG']);
});

test('residue providers leave in a name does not reach the filename', () => {
  const cases = [
    // A language suffix, wherever it landed, is English and not the title.
    ['The Wire-eng', 2002, 'The Wire (2002) 1080p ENG.mkv'],
    ['Fargo_eng', 2014, 'Fargo (2014) 1080p ENG.mkv'],
    ['Monsters, Inc.-eng', 2001, 'Monsters, Inc. (2001) 1080p ENG.mkv'],
    ['Who Framed Roger Rabbit?_eng (1988)', 1988, 'Who Framed Roger Rabbit? (1988) 1080p ENG.mkv'],
    ['Jaws (1975)_eng', 1975, 'Jaws (1975) 1080p ENG.mkv'],
    ['EN - Alien - 1979_eng', 1979, 'Alien (1979) 1080p ENG.mkv'],
    ['EN - Mission: Impossible 1996_eng', null, 'Mission: Impossible (1996) 1080p ENG.mkv'],
    ['EN - Aliens.1986 _eng', null, 'Aliens (1986) 1080p ENG.mkv'],
    ['EN - 12.Angry.Men.1957_eng', null, '12 Angry Men (1957) 1080p ENG.mkv'],
    ['Oldboy (SUB) -eng', 2003, 'Oldboy (2003) 1080p SUB.mkv'],
    // A bracket never closed, on a year or a country.
    ['EN - Gravity (20130', 2013, 'Gravity (2013) 1080p ENG.mkv'],
    ['EN - Titanic (1997', 1997, 'Titanic (1997) 1080p ENG.mkv'],
    ["EN - What's Up, Doc? (1972(", 1972, "What's Up, Doc? (1972) 1080p ENG.mkv"],
    ['EN - Ghost in the Shell: Innocence (2004_', 2004, 'Ghost in the Shell: Innocence (2004) 1080p ENG.mkv'],
    ['Jurassic Park (1993 MX', 1993, 'Jurassic Park (1993) 1080p.mkv'],
    ['EN - Yojimbo (1961 (MULTI SUB)', 1961, 'Yojimbo (1961) 1080p MULTI SUB.mkv'],
    ['D+ - Moana (US', 2016, 'Moana (2016) 1080p.mkv'],
    // Words in one are left alone, and so is a year followed by words and a close.
    ['Film (The Long Road', 2020, 'Film (The Long Road (2020) 1080p.mkv'],
    ['Film (1984 Revisited)', 2019, 'Film (1984 Revisited) (2019) 1080p.mkv'],
    // Stray punctuation in a year's bracket.
    ['EN - Le Samourai (1967.) (FRENCH ENG-SUB)', null, 'Le Samourai (1967) 1080p FRENCH ENG-SUB.mkv'],
    // Invisible format characters, including where they would hide a prefix.
    ['NF - Lost\u200B &\u200B Found\u200B (2026)', 2026, 'Lost & Found (2026) 1080p.mkv'],
    ['EN - Happy Feet – The Story\u200B(2006)', 2006, 'Happy Feet – The Story (2006) 1080p ENG.mkv'],
    ['\u200FEN - Film (2020)', 2020, 'Film (2020) 1080p ENG.mkv'],
    ['FR -4K \u200ELa Haine : J\'écris ton nom (1995)', 1995, "La Haine : J'écris ton nom (1995) 2160p.mkv"],
  ];
  for (const [name, year, expected] of cases) assert.equal(filename(name, { year }), expected, name);
  assert.equal(sanitizeTitle('Lost\u200B &\uFEFF Forgotten\u200F'), 'Lost & Forgotten');
  assert.equal(parseLanguage('Film\u200B [EN]\u200F'), 'EN');
  assert.equal(isPrereleaseCopy('\u200FEN - CAM (2018)'), false);
});

test('a name with dots for spaces is normalised, with or without a quality tag', () => {
  const cases = [
    ['NF - The.Dark.Knight.2008', null, 'The Dark Knight (2008) 1080p.mkv'],
    ['NF - Arrival.2016', null, 'Arrival (2016) 1080p.mkv'],
    ['NF - 10.1979', null, '10 (1979) 1080p.mkv'],
    ['NF - 12.Angry.Men-1957', null, '12 Angry Men (1957) 1080p.mkv'],
    ['NF - A.Passage.To.India.1984.1984', null, 'A Passage To India (1984) 1080p.mkv'],
    ['NF - THE.BIG.LEBOWSKI.1998', 1998, 'THE BIG LEBOWSKI (1998) 1080p.mkv'],
    ['4K-D+ - Toy.Story.Special.Edition.1995', null, 'Toy Story Special Edition (1995) 2160p.mkv'],
    ['EN - Romeo.+.Juliet (1996) LEONARDO DICAPRIO', 1996, 'Romeo + Juliet (1996) 1080p ENG.mkv'],
    // Its year only where it can be one: this film is from 1975, and that one 2017.
    ['Death.Race.2000', 1975, 'Death Race 2000 (1975) 1080p.mkv'],
    ['Blade.Runner.2049', 2017, 'Blade Runner 2049 (2017) 1080p.mkv'],
    // Unless the row's year is a word of the title.
    ['EN - 2001.A.Space.Odyssey.1968', 2001, '2001 A Space Odyssey (1968) 1080p ENG.mkv'],
    // Not a name in that form: initialisms, and too few words to tell.
    ['E.T.', 1982, 'E.T. (1982) 1080p.mkv'],
    ['HBO - S.W.A.T. (2003)', 2003, 'S.W.A.T. (2003) 1080p.mkv'],
    ['S.W.A.T.2017', null, 'S.W.A.T (2017) 1080p.mkv'],
    ['Mr.Bean', 1990, 'Mr.Bean (1990) 1080p.mkv'],
    ['Vol.2', null, 'Vol.2 1080p.mkv'],
    ['EN - L.A. Confidential (1997)', 1997, 'L.A. Confidential (1997) 1080p ENG.mkv'],
    // A hyphen and a year is not one either, with no dots to say so.
    ['X-2000', null, 'X-2000 1080p.mkv'],
  ];
  for (const [name, year, expected] of cases) assert.equal(filename(name, { year }), expected, name);
});

test('real quality words pass through, and none is ever invented', () => {
  const tags = (name) => parseName(name).tags;
  for (const word of ['WEB-DL', 'WEBRip', 'BluRay', 'REMUX', 'HDRip', 'DVDRip', 'HDTV', 'HDCAM', 'CAMRip', 'HDTS', 'TELESYNC', 'PreDVD', 'HDTC', 'TELECINE', 'DVDSCR']) {
    assert.deepEqual(tags(`Show (2020) ${word}`), [word], word);
  }
  assert.deepEqual(tags('Film'), []);
  assert.deepEqual(tags('EN - Film 4K (2020)'), []);
  assert.deepEqual(tags('Film (2020) SOME ACTOR'), []);
  // The first of a repeat, whatever its case.
  assert.deepEqual(tags('Film (2020) WEB-DL web-dl'), ['WEB-DL']);
});

test('a filename with .ts cannot be read as Telesync, and the check can tell', () => {
  // Release-name parsers test the whole string, extension included, so a bare ts token reads as Telesync.
  const telesync = /(?:^|[\s.\-_,[(])ts(?=[\s.\-_,)\]]|$)/i;
  assert.ok(telesync.test('Alien (1979) 1080p ENG.ts'), 'the check would catch a .ts extension');
  for (const name of ['EN - Alien - 1979', 'Film', 'NF - Roma (MX)']) {
    const result = filename(name, { ext: 'ts' });
    assert.ok(!result.endsWith('.ts'), result);
    assert.ok(!telesync.test(result), result);
  }
  // Its relatives too, and nothing else loses its extension.
  assert.equal(filename('Film', { ext: 'm2ts' }), 'Film 1080p');
  assert.equal(filename('Film', { ext: 'mts' }), 'Film 1080p');
  for (const ext of ['mkv', 'mp4', 'm4v', 'avi']) assert.equal(filename('Film', { ext }), `Film 1080p.${ext}`);
});

test('an episode has its year before the season and episode', () => {
  assert.equal(filename('EN - The Wire (2002)', { year: 2002, episode: 'S01E02' }), 'The Wire (2002) S01E02 1080p ENG.mkv');
  assert.equal(filename('The Wire-eng', { year: 2002, episode: 'S01E02' }), 'The Wire (2002) S01E02 1080p ENG.mkv');
  assert.equal(filename('NF - Show', { episode: 'S01E02' }), 'Show S01E02 1080p.mkv');
});

test('pre-release copies are recognised from explicit tags only', () => {
  const copies = [
    'Film 2026 HDCAM', 'Film.2026.CAMRip.x264', 'Film (2026) HD-CAM', 'Film 2026 CAM', 'Film [cam]', 'Film (ts)',
    'Film 2026 TS', 'Film.2026.HDTS', 'Film TELESYNC', 'Film PDVD', 'Film PreDVDRip', 'Film 2026 TC', 'Film HDTC',
    'Film Telecine', 'Film 2026 SCR', 'Film DVDSCR', 'Film WEB-SCR', 'Film SCREENER', 'Film [Screener]',
    'EN - Fresh Film (2026) HDCAM', '4K-NF - Fresh Film (2026) TS',
  ];
  for (const name of copies) assert.equal(isPrereleaseCopy(name), true, name);
  const films = [
    'Cam', 'CAM', 'Cam (2018)', 'CAM (2018)', 'Camelot', 'The Camera', 'Scream', 'Screenplay', 'Tsotsi', 'T.S. Eliot',
    'TC', 'Roots', 'Cats', 'Film 2026 1080p', 'Film WEB-DL', 'Film HDTV', 'The Screener', 'Film.ts',
    // A provider prefix is not the start of the title, so these still open their names.
    'EN - CAM (2018)', 'HBO - Cam', 'EN - EN - CAM (2018)', '4K-NF - TC',
    '', null, undefined, 42,
  ];
  for (const name of films) assert.equal(isPrereleaseCopy(name), false, String(name));
});

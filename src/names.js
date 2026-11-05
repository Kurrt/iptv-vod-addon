// Everything derived from a provider's display name. None of this takes part in
// matching: names only decide how a stream is labelled, and the pre-release filter.

// Dispatcharr appends a language to a name as a two-letter tag, like [EN].
const LANGUAGE_SUFFIX = /\[([A-Za-z]{2})\]\s*$/;
// These fit that pattern but describe the picture, not the language, and they
// reach us because Dispatcharr passes a provider's name through unchanged. HD, TV
// and CC are not ISO 639-1 codes. SD is Sindhi's, but is far more often a quality.
const NOT_LANGUAGES = new Set(['HD', 'SD', 'TV', 'CC']);
const MAX_TITLE_LENGTH = 160;

// Invisible format characters (zero-width spaces, direction marks) go entirely, because
// some sit inside words. One in front of a prefix would also stop it being recognised.
const collapse = (text) => text
  .replace(/\p{Cf}/gu, '')
  .replace(/[\p{Cc}\p{Zl}\p{Zp}/\\]+/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// The trailing language tag, looking past any quality tags after it.
function findLanguageTag(text) {
  let end = text.length;
  for (;;) {
    const match = LANGUAGE_SUFFIX.exec(text.slice(0, end));
    if (!match || !NOT_LANGUAGES.has(match[1].toUpperCase())) return match;
    end = match.index;
  }
}

export function parseLanguage(name) {
  const tag = typeof name === 'string' ? findLanguageTag(collapse(name)) : null;
  return tag ? tag[1].toUpperCase() : null;
}

// slice counts UTF-16 units, so it can leave half an emoji at the end. JSON.stringify
// writes that as a lone \\ud83c, and a strict JSON parser then rejects the whole
// response. toWellFormed covers the same thing arriving from a provider.
function clip(text) {
  const cut = text.slice(0, MAX_TITLE_LENGTH);
  return (/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut).toWellFormed();
}

// Strips path separators, control characters and the language suffix, so the
// result is safe to use as a filename stem. The provider's other text stays:
// parseName works from it when a stream is labelled.
export function sanitizeTitle(name) {
  const text = typeof name === 'string' ? collapse(name) : '';
  const tag = findLanguageTag(text);
  const bare = tag ? text.slice(0, tag.index) + text.slice(tag.index + tag[0].length) : text;
  return clip(bare).replace(/^[.\s]+|[.\s]+$/g, '') || 'Unknown';
}

// The category tags providers put in front of a title: a language, or a streaming
// service's usual short name. The list is closed and case-sensitive because real titles
// have the same shape: "Heat - 1995", "SAS - Rogue Heroes". An unlisted tag stays in
// the title, which only looks untidy, whereas stripping a real title's first words loses
// them. EXTRA_PROVIDER_TAGS adds a source's own tags to it.
const PROVIDER_TAGS = [
  'EN', 'En', 'FR', 'AR', 'NF', 'AMZ', 'HBO', 'MAX', 'SKY', 'NICK', 'PRMT', 'PCOK', 'SHWT', 'DWA', 'UNV', 'MRVL',
  'D\\+', 'A\\+', 'P\\+', 'DSC\\+',
];
// An optional list number and 4K marker come first: "09 EN - ", "4K-NF - ". The looser
// marker and dash cover "EN -4k EN - ", which the loop below takes in two bites. The other
// separators are the near-misses seen on the commonest tags: "EN- Alien", "EN: Alien",
// "NF + Roma". A bare tag needs a capitalised word next: "EN The Matrix", which "EN
// (2020)" and "EN GARDE" are not.
const buildProviderPrefix = (tags) => new RegExp('^(?:\\d{1,3}\\s+)?(?:4[Kk]-?\\s*)?(?:'
  + `(${tags.join('|')})\\s+-\\s*`
  + '|(EN|NF)(?:\\s*[:+]\\s*|-\\s+)'
  + '|(EN)\\s+(?=\\p{Lu}\\p{Ll})'
  + ')', 'u');
const ENGLISH_TAGS = new Set(['EN', 'En']);

let providerPrefix = buildProviderPrefix(PROVIDER_TAGS);

// Called once at startup, before any name is read. These come from a setting, so they are
// matched literally: "X+" means an X and a plus sign.
export function setExtraProviderTags(tags) {
  providerPrefix = buildProviderPrefix([...PROVIDER_TAGS, ...tags.map((tag) => RegExp.escape(tag))]);
}

function stripProviderPrefix(text) {
  let rest = text;
  let english = false;
  for (let match = providerPrefix.exec(rest); match; match = providerPrefix.exec(rest)) {
    const tag = match.slice(1).find(Boolean);
    if (ENGLISH_TAGS.has(tag)) english = true;
    rest = rest.slice(match[0].length);
  }
  // A marker that has lost its tag: "AMZ - 4K-Arrival", "EN -4k Alien".
  // Without a prefix in front, "4K Something" may be the title.
  const marker = rest === text ? /^4[Kk]-(?=\S)/ : /^(?:4[Kk][-\s]+)+(?=\S)/;
  return { rest: rest.replace(marker, ''), english };
}

const HEIGHT_TAGS = new Map([
  [4320, '2160p'], [2160, '2160p'], [2122, '2160p'], [1440, '1440p'], [1080, '1080p'], [900, '720p'],
  [800, '720p'], [720, '720p'], [576, '576p'], [540, '480p'], [480, '480p'], [464, '480p'], [368, '360p'],
  [360, '360p'], [240, '240p'],
]);
const WORD_TAGS = new Map([
  ['8k', '2160p'], ['4k', '2160p'], ['uhd', '2160p'], ['qhd', '1440p'], ['fhd', '1080p'],
]);
const RANK = new Map(['240p', '360p', '480p', '576p', '720p', '1080p', '1440p', '2160p'].map((tag, i) => [tag, i]));

const HEIGHT_TOKEN = /(?<![a-z0-9])(\d{3,4})(?:[pi](?:\d{2,3})?|p?hd)(?![a-z0-9])/g;
const WORD_TOKEN = /(?<![a-z0-9])(8k|4k|uhd|qhd|fhd)(?![a-z0-9])/g;
// "4K Restored" describes the scan, not this file.
const NOT_A_RESOLUTION_AFTER_4K = /^[\s._-]*(?:restored|remastered|restoration)(?![a-z0-9])/;
const DIMENSIONS = /(?<![a-z0-9])(\d{3,4})\s?[x×]\s?(\d{3,4})(?![a-z0-9])/;
// "(SD)", and a bare SD closing the name after a year or a bracket: "Alien (1979) SD".
// Anywhere else it is too likely to be a word: "SD Gundam Force".
const SD_MARKER = /[([]\s*sd\s*[)\]]|(?:\d{4}\)?|\))\s+sd\s*$/;

// Width names the class because films are cropped.
function tagForWidth(width) {
  if (width >= 3700) return '2160p';
  if (width >= 2400) return '1440p';
  if (width >= 1850) return '1080p';
  if (width >= 1200) return '720p';
  if (width >= 700) return '480p';
  if (width >= 480) return '360p';
  return null;
}

// Returns the resolution a name clearly carries, or null. When a name carries
// several the lowest wins, because "UHD BluRay 1080p" is a 1080p encode of a UHD
// source. Reads the raw name, so a marker in a provider prefix ("4K-NF - ") counts.
export function resolutionFromName(name) {
  if (typeof name !== 'string') return null;
  const text = name.toLowerCase();
  const found = [];
  for (const match of text.matchAll(HEIGHT_TOKEN)) {
    const tag = HEIGHT_TAGS.get(Number(match[1]));
    if (tag) found.push(tag);
  }
  for (const match of text.matchAll(WORD_TOKEN)) {
    const rest = text.slice(match.index + match[0].length);
    if (match[1] === '4k' && NOT_A_RESOLUTION_AFTER_4K.test(rest)) continue;
    found.push(WORD_TAGS.get(match[1]));
  }
  if (SD_MARKER.test(text)) found.push('480p');
  if (found.length > 0) {
    return found.reduce((low, tag) => (RANK.get(tag) < RANK.get(low) ? tag : low));
  }
  const size = DIMENSIONS.exec(text);
  if (size) {
    const [width, height] = [Number(size[1]), Number(size[2])];
    if (width >= 320 && width <= 8192 && height >= 200 && height <= 4320 && width > height) {
      return tagForWidth(width);
    }
  }
  return null;
}

const bounded = (source) => `(?<![a-z0-9])(?:${source})(?![a-z0-9])`;

const RESOLUTION_SOURCE = `(?:${[...HEIGHT_TAGS.keys()].join('|')})(?:[pi](?:\\d{2,3})?|p?hd)`
  + '|8k|uhd|qhd|fhd|4k(?![\\s._-]*(?:restored|remastered|restoration)(?![a-z0-9]))'
  + '|\\d{3,4}\\s?[x×]\\s?\\d{3,4}';
// Only tags a name states. A bare "web" is too common a word to count unless it
// directly follows a resolution, as in "1080p.web.h264".
const QUALITY_SOURCE = 'web[ ._-]?dl|web[ ._-]?rip|(?<=\\d[pi][ ._-])web|blu[ ._-]?ray|(?:bd|br)[ ._-]?rip'
  + '|(?:(?:bd|br|uhd)[ ._-]?)?remux|hd[ ._-]?rip|dvd[ ._-]?rip|hdtv|hd[ ._-]?cam|cam[ ._-]?rip|hd[ ._-]?ts|telesync'
  + '|pre[ ._-]?dvd(?:rip)?|pdvd|hd[ ._-]?tc|telecine|(?:dvd|bd|web|hd)[ ._-]?scr(?:eener)?';
const CODEC_SOURCE = 'h\\.?26[45]|x\\.?26[45]|hevc|avc|av1|xvid|divx|10[ ._-]?bit|hdr10(?:\\+|plus)?|hdr';

const TECHNICAL_SOURCE = bounded(`${RESOLUTION_SOURCE}|${QUALITY_SOURCE}|${CODEC_SOURCE}`);
const TECHNICAL = new RegExp(TECHNICAL_SOURCE, 'i');
const QUALITY_TOKEN = new RegExp(bounded(QUALITY_SOURCE), 'gi');
const CODEC_TOKEN = new RegExp(bounded(CODEC_SOURCE), 'gi');

const YEAR_SOURCE = '(?:18|19|20)\\d{2}';
// "(1999)", "(2015-2018)", "(2015-)" and the "(-2024)" some providers write.
const BRACKET_YEAR = new RegExp(`[(\\[]\\s*-?\\s*(${YEAR_SOURCE})(?:\\s*[-–]\\s*(\\d{0,4}))?\\s*\\.?\\s*[)\\]]`);
// One the provider never closed: "(1999", "(1999(", "(1999_", "(19990", "(1999 (MULTI SUB)".
// A closing bracket further on makes it words: "(1984 Revisited)".
const UNCLOSED_YEAR = new RegExp(`[(\\[]\\s*(${YEAR_SOURCE})\\d?(?!\\d)(?![^()[\\]]*[)\\]])`);
// "Heat - 1995". Only a year when something a year can be followed by comes next, or
// it is the row's own year, because "Film - 1984 Revisited" is a title.
const DASH_YEAR = new RegExp(`\\s-\\s(${YEAR_SOURCE})(?![a-z0-9])`, 'gi');
const AFTER_DASH_YEAR = new RegExp(`^(?:\\s*$|\\s*[(\\[_-]|\\s+(?:${TECHNICAL_SOURCE}|e?-?subs?(?![a-z0-9])|hc(?![a-z0-9])|sd(?![a-z0-9])|hd(?![a-z0-9])))`, 'i');
const TRAILING_YEAR = new RegExp(`^(.*\\S)[\\s,.]+(${YEAR_SOURCE})$`);
const ENGLISH_SUFFIX = /\s*[-_]eng$/;

const LANGUAGE_NAMES = [
  'ENGLISH', 'FRENCH', 'ITALIAN', 'SPANISH', 'GERMAN', 'JAPANESE', 'CHINESE', 'MANDARIN', 'CANTONESE', 'KOREAN',
  'HINDI', 'TAMIL', 'TELUGU', 'POLISH', 'NORWEGIAN', 'SWEDISH', 'DANISH', 'FINNISH', 'DUTCH', 'PERSIAN', 'FARSI',
  'PORTUGUESE', 'ARABIC', 'TURKISH', 'CZECH', 'SLOVAK', 'HUNGARIAN', 'ROMANIAN', 'RUSSIAN', 'UKRAINIAN', 'GREEK',
  'FILIPINO', 'THAI', 'AFGHAN', 'QUEBEC', 'TRUEFRENCH', 'HEBREW', 'BULGARIAN', 'SERBIAN', 'CROATIAN', 'SLOVENIAN',
  'LATVIAN', 'LITHUANIAN', 'ESTONIAN', 'VIETNAMESE', 'INDONESIAN', 'MALAY', 'PUNJABI', 'BENGALI', 'MARATHI', 'GUJARATI',
  'KANNADA', 'MALAYALAM', 'LATINO',
];
const LANGUAGE_WORDS = new Set([
  ...LANGUAGE_NAMES, 'ENG', 'EN', 'FR', 'FRA', 'IT', 'ITA', 'SP', 'SPA', 'ESP', 'GER', 'DEU', 'DE', 'JAP', 'JPN',
  'JP', 'CHI', 'CN', 'KOR', 'KO', 'HIN', 'POL', 'NOR', 'SWE', 'DAN', 'PER', 'POR', 'PT', 'ARA', 'AR', 'TUR', 'CZE',
  'RUS', 'RU', 'MULTI', 'DUAL', 'DUB', 'DUBBED',
]);
const LANGUAGE_MODIFIERS = new Set(['SUB', 'SUBS', 'SUBBED', 'SUBTITLES', 'ONLY', 'NO', 'AUDIO']);
const YEAR_THEN_LANGUAGE = new RegExp(`^(.*\\s${YEAR_SOURCE})\\s+(${LANGUAGE_NAMES.join('|')})$`, 'i');
const BARE_LANGUAGE = new RegExp(`(?<![a-z0-9])(?:${LANGUAGE_NAMES.join('|')})(?![a-z0-9])`, 'gi');

const BRACKET_GROUP = /[([]([^()[\]]*)[)\]]/g;
// One left open at the very end of a name: "(CHINESE ENG-SUB", "(FRENCH ENG-SUB_", "(US".
const UNCLOSED_BRACKET = /[([]([^()[\]]*?)[_\s]*[([]?$/;
// Whatever else it holds, a bracket closing on one of these describes the audio or the
// subtitles: "(SWAHILI MULTI SUB)", "(FRENCH MULTY SUB)", "(FRNCH ONLY)". Uppercase only,
// because "(Members Only)" is a title.
const LANGUAGE_CLOSER = /(?:^|[\s-])(?:SUB|SUBS|ONLY)$/;

function classifyBracket(content) {
  const text = content.trim();
  // Countries ("(GB)", "(KR)") and picture tags ("[HD]"). "(FR)" is France here, not French.
  if (/^[A-Za-z]{2}$/.test(text)) return 'drop';
  if (resolutionFromName(text) !== null) return 'drop';
  if (LANGUAGE_CLOSER.test(text)) return 'language';
  const words = text.toUpperCase().split(/[\s&-]+/).filter(Boolean);
  const isLanguage = words.some((word) => LANGUAGE_WORDS.has(word))
    && words.every((word) => LANGUAGE_WORDS.has(word) || LANGUAGE_MODIFIERS.has(word));
  return isLanguage ? 'language' : 'title';
}

const languageWords = (content) => content.replace(/&/g, ' ').replace(/\s+/g, ' ').trim();

// Takes an unclosed bracket off the end of `text`, unless it reads as title words.
function takeUnclosedBracket(text, languages) {
  const match = UNCLOSED_BRACKET.exec(text);
  if (!match) return text;
  const kind = classifyBracket(match[1]);
  if (kind === 'title') return text;
  if (kind === 'language') languages.push(languageWords(match[1]));
  return text.slice(0, match.index);
}

function findDashYear(text, rowYear) {
  for (const match of text.matchAll(DASH_YEAR)) {
    const after = text.slice(match.index + match[0].length);
    if (Number(match[1]) === rowYear || AFTER_DASH_YEAR.test(after)) return match;
  }
  return null;
}

// `yearEnd` is the end of a stated range. "(2015-)", "(2017-19)" and a typing slip such
// as "(1993-1004)" do not give one that can be compared, so they read as open-ended.
function yearEndOf(year, rangeEnd) {
  if (rangeEnd === undefined) return year;
  const end = Number(rangeEnd);
  return rangeEnd.length === 4 && end >= year ? end : Infinity;
}

function splitAtYear(text, rowYear) {
  const marker = [BRACKET_YEAR.exec(text), findDashYear(text, rowYear), UNCLOSED_YEAR.exec(text)]
    .filter(Boolean)
    .sort((a, b) => a.index - b.index)[0];
  if (!marker) return { head: text, tail: '', year: null, yearEnd: null };
  const year = Number(marker[1]);
  const yearEnd = yearEndOf(year, marker[2]);
  const before = text.slice(0, marker.index);
  const after = text.slice(marker.index + marker[0].length);
  return before.trim() === '' ? { head: after, tail: '', year, yearEnd } : { head: before, tail: after, year, yearEnd };
}

const ENDS_IN_YEAR = new RegExp(`[.-](${YEAR_SOURCE})$`);

// A name with dots for spaces: "The.Dark.Knight.2008", "Arrival.2016", "12.Angry.Men-1957".
// Returns it with spaces, and any closing year as its last word, or null if it is not
// one. "Mr.Bean" and "Vol.2" have too few words to tell, and all single letters is an
// initialism, "E.T." or "S.W.A.T.2017", so those keep their dots.
function undot(text) {
  if (/\s/.test(text) || !text.includes('.')) return null;
  const closing = ENDS_IN_YEAR.exec(text);
  const body = closing ? text.slice(0, closing.index) : text;
  const words = body.split('.').filter(Boolean);
  const initialism = words.every((word) => word.length === 1);
  if (!closing && (initialism || words.length < 3)) return null;
  const title = initialism ? body : words.join(' ');
  return closing ? `${title} ${closing[1]}` : title;
}

// Whether a year-shaped number is one of the title's words: "1917", "Fantasia 2000".
const titleHasNumber = (title, number) => new RegExp(`(?<![\\p{L}\\p{N}])${number}(?![\\p{L}\\p{N}])`, 'u').test(title);

// The year to print, and whether the name and the row disagree about it. The row's year
// comes first, but it is the provider's data, not the id's: the name can be right, and
// a disagreement may mean the id names another title of the same name.
//
// A row year that is one of the title's words came from the title, in the fallback
// Dispatcharr uses when a provider sends no year, so the name's own year is the real one.
// A film's year is a single point, so a real disagreement prints the name's year, which
// leaves the conflict visible to whatever filters on year. A show spans years, so its
// name may be stating a later season or a revival: the row's year stays and it is only
// counted, and not at all if a range in the name covers it.
function settleYear({ rowYear, nameYear, nameYearEnd, title, series }) {
  if (rowYear === null || nameYear === null) return { year: rowYear ?? nameYear, conflict: false };
  if (titleHasNumber(title, rowYear)) return { year: nameYear, conflict: false };
  const agrees = rowYear >= nameYear - 1 && rowYear <= nameYearEnd + 1;
  if (agrees) return { year: rowYear, conflict: false };
  return { year: series ? rowYear : nameYear, conflict: true };
}

function unique(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const tidy = (text) => text.replace(/\s+/g, ' ').replace(/^[\s\-–:,.]+|[\s\-–:,]+$/g, '');

// Splits a provider's name into what a filename parser needs. Title words stay, apart
// from what is clearly not part of the title. After the year, only quality, codec and
// language words survive: the rest is residue such as actor names.
//
// `year` is the row's own year, which settleYear weighs against any in the name.
// `language` is the row's [XX] suffix, which sanitizeTitle has already removed from the
// name. `series` says a show's row is being read, not a film's.
export function parseName(name, { year: rowYear = null, language = null, series = false } = {}) {
  const text = typeof name === 'string' ? collapse(name) : '';
  const { rest, english } = stripProviderPrefix(text);
  const split = splitAtYear(rest, rowYear);
  const languages = [];

  let inHead = split.head.replace(BRACKET_GROUP, (group, content) => {
    const kind = classifyBracket(content);
    if (kind === 'language') languages.push(languageWords(content));
    return kind === 'title' ? group : ' ';
  });
  inHead = takeUnclosedBracket(inHead, languages);
  for (const [, content] of split.tail.matchAll(BRACKET_GROUP)) {
    if (classifyBracket(content) === 'language') languages.push(languageWords(content));
  }
  takeUnclosedBracket(split.tail, languages);

  // "The Wire-eng", "Title_eng (2024)", "Alien - 1979_eng". Not part of the title.
  const suffixed = ENGLISH_SUFFIX.test(inHead.trimEnd());
  if (suffixed) inHead = inHead.trimEnd().replace(ENGLISH_SUFFIX, '');
  const marksEnglish = english || suffixed || ENGLISH_SUFFIX.test(split.tail.trimEnd());

  // A resolution or quality word inside the title part means the technical section
  // starts there: "Alien 4k", "The Matrix 1999 720p WEB-DL x264 NOGRP", "X2.2003.2160p".
  const cut = TECHNICAL.exec(inHead);
  const scene = cut !== null && cut.index > 0;
  let head = scene ? inHead.slice(0, cut.index) : inHead;
  const cutPart = scene ? inHead.slice(cut.index) : '';
  if (scene && !/\s/.test(head.trim())) head = head.replace(/\./g, ' ');
  head = head.trim();
  const undotted = scene ? null : undot(head);
  if (undotted !== null) head = undotted;

  if (scene) {
    // "Amelie.2001.FRENCH.1080p" and "Film.2024.1080p.FRENCH.WEB-DL".
    const peeled = YEAR_THEN_LANGUAGE.exec(head);
    if (peeled) {
      head = peeled[1];
      languages.push(peeled[2]);
    }
    for (const [word] of cutPart.matchAll(BARE_LANGUAGE)) languages.push(word);
  }

  // A number ending a title is only a year when nothing else in the name is one, and it
  // matches the row or the name is in release format. "Blade Runner 2049" and "Dracula
  // 2000 (2000)" keep their numbers, and a film called "2012" keeps its only word. Release
  // names can repeat it: "Arrival.2016.2016.1080p". Dots or a suffix alone are weaker
  // evidence than a quality tag, so there it also has to fit the row: "Death.Race.2000",
  // from 1975, keeps its number, unless the row's year is a title word itself:
  // "2001.A.Space.Odyssey.1968".
  const trailingIsYear = (candidate, before) => {
    if (split.year !== null) return scene && candidate === rowYear;
    if (candidate === rowYear || scene) return true;
    if (undotted === null && !suffixed) return false;
    return rowYear === null || Math.abs(candidate - rowYear) <= 1 || titleHasNumber(before, rowYear);
  };
  let bareYear = null;
  for (let match = TRAILING_YEAR.exec(head); match; match = TRAILING_YEAR.exec(head)) {
    const candidate = Number(match[2]);
    if (!trailingIsYear(candidate, match[1])) break;
    bareYear ??= candidate;
    head = match[1];
  }

  // Left in, a parser reads this 4K as the resolution and ignores the token we add.
  head = head.replace(/(?<![a-z0-9])4k[\s._-]+(?=(?:restored|remastered|restoration)(?![a-z0-9]))/i, '');

  const technical = `${cutPart} ${split.tail}`;
  const tags = unique([...technical.matchAll(QUALITY_TOKEN), ...technical.matchAll(CODEC_TOKEN)].map(([word]) => word));

  if (language !== null && language !== 'EN') languages.push(language);
  // A strict language requirement drops an untagged stream, so a source's own English
  // tag is carried over as a word filename parsers read. Not when the name states
  // another language: "(FRENCH ONLY)" under an EN tag is French.
  if (languages.length === 0 && (marksEnglish || language === 'EN')) languages.push('ENG');

  const title = tidy(head) || 'Unknown';
  const { year, conflict } = settleYear({
    rowYear,
    nameYear: split.year ?? bareYear,
    nameYearEnd: split.yearEnd ?? bareYear,
    title,
    series,
  });

  return {
    title,
    year,
    yearConflict: conflict,
    resolution: resolutionFromName(text),
    tags,
    languages: unique(languages),
  };
}

// Pre-release copies. Only explicit tags count. A bare tag must be uppercase and
// cannot open the title, because "Cam" (2018) is a real film, so a mislabelled copy
// can still get through. A provider prefix is not part of the title, or "EN - CAM
// (2018)" would count as a copy.
const PRERELEASE_TAG = /(?<![a-z0-9])(?:hd[ ._-]?cam|cam[ ._-]?rip|hd[ ._-]?ts|telesync|pre[ ._-]?dvd(?:rip)?|pdvd|hd[ ._-]?tc|telecine|(?:dvd|bd|web|hd)[ ._-]?scr(?:eener)?)(?![a-z0-9])/i;
const PRERELEASE_BRACKETED = /[[(]\s*(?:cam|ts|tc|scr|screener)\s*[\])]/i;
const PRERELEASE_BARE = /(?<![A-Za-z0-9])(?:CAM|TS|TC|SCR|SCREENER)(?![A-Za-z0-9])/g;

export function isPrereleaseCopy(name) {
  if (typeof name !== 'string') return false;
  const { rest } = stripProviderPrefix(collapse(name));
  if (PRERELEASE_TAG.test(rest) || PRERELEASE_BRACKETED.test(rest)) return true;
  return [...rest.matchAll(PRERELEASE_BARE)].some((match) => match.index > 0);
}

export function normalizeExtension(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase().replace(/^\./, '') : '';
  // Dispatcharr uses the same default when a relation has no container_extension.
  return /^[a-z0-9]{1,8}$/.test(text) ? text : 'mp4';
}

export function normalizeYear(...candidates) {
  for (const candidate of candidates) {
    const match = /^\s*(\d{4})(?!\d)/.exec(String(candidate ?? ''));
    if (match) {
      const year = Number(match[1]);
      if (year >= 1800 && year <= 2100) return year;
    }
  }
  return null;
}

export function isTruthyFlag(value) {
  if (typeof value === 'string') {
    return !['', '0', 'false', 'no', 'null'].includes(value.trim().toLowerCase());
  }
  return Boolean(value);
}

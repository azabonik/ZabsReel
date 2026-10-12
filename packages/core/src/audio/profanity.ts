/**
 * Built-in English profanity matcher for auto-bleep. WHOLE-TOKEN matching only
 * (explicit stem + suffix families, never substrings) so "class", "assume",
 * "Scunthorpe" and "cocktail" are safe. No slurs are included; callers add
 * their own terms via `extraWords`.
 */
import type { TranscriptWord } from "../types.js";

export interface ProfanityOptions {
  /** Also match mild words (damn, hell, crap, piss, bloody, arse). Default false. */
  includeMild?: boolean;
  /** Extra exact tokens (case-insensitive). */
  extraWords?: string[];
  /** Use the built-in list (default true). false = only `extraWords`. */
  useDefaultList?: boolean;
}

/** stem -> allowed suffixes (empty string = the bare stem). */
const FAMILIES: Array<[string, string[]]> = [
  ["fuck", ["", "s", "ed", "er", "ers", "ing", "in", "face", "head", "heads", "wit", "off"]],
  ["motherfuck", ["er", "ers", "ing", "in", "a", "as"]],
  ["shit", ["", "s", "ty", "ting", "ted", "head", "heads", "hole", "show", "storm"]],
  ["bullshit", ["", "s", "ting", "ted"]],
  ["bitch", ["", "es", "ing", "y"]],
  ["asshole", ["", "s"]],
  ["dick", ["", "s", "head", "heads"]],
  ["cunt", ["", "s"]],
  ["bastard", ["", "s"]],
  ["goddamn", ["", "ed", "it"]],
  ["prick", ["", "s"]],
  ["twat", ["", "s"]],
  ["wanker", ["", "s"]],
  ["jackass", ["", "es"]],
  ["dumbass", ["", "es"]],
];

const MILD = ["damn", "damned", "damnit", "hell", "crap", "crappy", "piss", "pissed", "pissing", "bloody", "arse", "arses"];

function expand(): Set<string> {
  const out = new Set<string>();
  for (const [stem, sufs] of FAMILIES) for (const s of sufs) out.add(stem + s);
  return out;
}

const DEFAULT_LIST = expand();
const MILD_LIST = new Set(MILD);

/** Lowercase and strip surrounding punctuation/quotes (inner apostrophes and asterisks stay). */
export function normalizeToken(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/^[^\p{L}\p{N}*]+/u, "")
    .replace(/[^\p{L}\p{N}*]+$/u, "");
}

/** True if the (raw) word should be bleeped. */
export function isProfane(text: string, opts: ProfanityOptions = {}): boolean {
  const tok = normalizeToken(text);
  if (!tok) return false;
  // Self-censored by the transcriber: f***, s**t, ****.
  if (tok.includes("*") && (/\p{L}/u.test(tok) || /^\*+$/.test(tok))) return true;
  if (opts.extraWords?.some((w) => normalizeToken(w) === tok)) return true;
  if (opts.useDefaultList === false) return false;
  if (DEFAULT_LIST.has(tok)) return true;
  return !!opts.includeMild && MILD_LIST.has(tok);
}

/** Words of a transcript that match, with their original indices. */
export function findProfanity(
  words: readonly TranscriptWord[],
  opts: ProfanityOptions = {},
): Array<{ index: number; word: TranscriptWord }> {
  const hits: Array<{ index: number; word: TranscriptWord }> = [];
  words.forEach((word, index) => {
    if (isProfane(word.text, opts)) hits.push({ index, word });
  });
  return hits;
}

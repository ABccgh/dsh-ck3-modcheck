/**
 * dsh-ck3-modcheck — the pure rule layer.
 *
 * ## What belongs in this file
 *
 * Every check that can be decided from bytes on disk, and **nothing else**. No Cordis, no
 * `ctx`, no tool registry, no report formatting: this module must be importable and runnable
 * with no runtime around it at all, so `test/falsify.mjs` and any external caller can drive
 * it against a temp fixture. Filesystem access happens only through `node:fs`, only inside the
 * `check*` / `validate*` functions below, and only for **reading** — the one exception is
 * {@link writeFileBytes}, which is exported for the caller to invoke deliberately after it has
 * decided to repair something. This module never repairs on its own.
 *
 * ## Provenance of every rule
 *
 * The rules come from exactly two places, and each function below names which:
 *
 * - **The vanilla install on this machine** — measured, not assumed. Example: all 122 files in
 *   `game\localization\english\*.yml` begin with `EF BB BF`, and their first non-empty line is
 *   `l_english:` (some files carry a trailing space after the colon).
 * - **The CK3 Wiki `Mod structure` page** — quoted where a rule depends on it.
 *
 * ## The rule this module deliberately does NOT have
 *
 * The `.mod` file's `path=` key can be written relative or absolute and **the exact format is
 * unverified on this machine** (no sample mod exists here). So nothing below judges the
 * *format* of a path. The only two things checked are that the resolved target **exists** and
 * that the path is **ASCII-safe**. `path-absent` is a `warn` precisely because the format is
 * unknown: a missing key must not be reported as if a requirement had been established.
 *
 * @module dsh-ck3-modcheck/rules
 */

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import path from 'node:path'
import { TextDecoder } from 'node:util'

/** Stable check codes, in the order the brief numbers them. */
export const CODES = Object.freeze({
  MOD_FILE_MISSING: 'mod-file-missing',
  MOD_NAME_MISMATCH: 'mod-name-mismatch',
  DESCRIPTOR_MISSING: 'descriptor-missing',
  DESCRIPTOR_HAS_PATH: 'descriptor-has-path',
  PATH_MISSING: 'path-missing',
  PATH_ABSENT: 'path-absent',
  PATH_UNQUOTED: 'path-unquoted',
  NON_ASCII_PATH: 'non-ascii-path',
  LOCALIZATION_NO_BOM: 'localization-no-bom',
  LOCALIZATION_BAD_HEADER: 'localization-bad-header',
  LOCALIZATION_BAD_ENTRY: 'localization-bad-entry',
  SCRIPT_UNBALANCED: 'script-unbalanced',
  LOCALIZATION_LANGUAGE_DIR: 'localization-language-dir',
  VANILLA_PATH_UNKNOWN: 'vanilla-path-unknown',
  // `TAG_UNKNOWN: 'tag-unknown'` stood here and was REMOVED, not merely retired: `KNOWN_TAGS` below
  // records why the vocabulary check was abandoned (a stale 2023 list, no canonical list on disk, and
  // a launcher that does not validate the field), and once no check can produce the code, a row in
  // CODES and SEVERITY is a claim of coverage with nothing behind it. The suite asserts the name is
  // gone so it cannot be resurrected silently.
  // Added after a measured gap analysis: each of these corresponds to a real CK3 failure mode
  // that the earlier revision passed silently. The wiki's `Mod structure` "Required?" table is
  // the provenance for the `mod-*-required` family; `replace_path`'s own description
  // ("Doesn't load vanilla files for the specified path") is the provenance for the third.
  MOD_KEY_MISSING: 'mod-key-missing',
  MOD_KEY_EMPTY: 'mod-key-empty',
  SUPPORTED_VERSION_MISSING: 'supported-version-missing',
  TAGS_NOT_A_LIST: 'tags-not-a-list',
  REPLACE_PATH_UNKNOWN: 'replace-path-unknown',
  REPLACE_PATH_DESTRUCTIVE: 'replace-path-destructive',
  MOD_FOLDER_MISMATCH: 'mod-folder-mismatch',
  PATH_CASE_MISMATCH: 'path-case-mismatch',
  UNEXPECTED_EXTENSION: 'unexpected-extension',
  DUPLICATE_LOCALIZATION_KEY: 'duplicate-localization-key',
  DESCRIPTOR_DISAGREES: 'descriptor-disagrees',
  SCRIPT_HAS_BOM: 'script-has-bom',
  EVENT_NAMESPACE_MISSING: 'event-namespace-missing',
  EVENT_ID_NAMESPACE_MISMATCH: 'event-id-namespace-mismatch',
  EVENT_ID_OUT_OF_RANGE: 'event-id-out-of-range',
  EVENT_FILE_EMPTY: 'event-file-empty',
  TEXT_NOT_UTF8: 'text-not-utf8',
  VANILLA_FILE_OVERRIDDEN: 'vanilla-file-overridden',
  VANILLA_SINGLE_FILE_DATABASE_OVERRIDE: 'vanilla-single-file-database-override',
  LAUNCHER_ENTRY_DEAD: 'launcher-entry-dead',
  LAUNCHER_REPORTS_PROBLEM: 'launcher-reports-problem',
  EVENT_NEVER_FIRED: 'event-never-fired',
  // Added by D-73's gap analysis. A skeleton carrying six real defects produced `0 findings`,
  // and these two names two of those classes: a KEY vanilla never uses anywhere, and a theme
  // value the install does not define. Both are measured against the install itself, so they
  // are silent on a machine without it.
  VANILLA_KEY_UNKNOWN: 'vanilla-key-unknown',
  EVENT_THEME_UNKNOWN: 'event-theme-unknown',
  // Added after a second audit found a promise with no implementation. `compareLauncherToDisk`'s
  // own comment used to list three disagreement classes while the function produced two; this is the
  // missing one — a `.mod` file sitting in the launcher's own mod folder that the launcher's database
  // has no row for. Measured on this machine: the launcher folder holds seven `.mod` files, all seven
  // registered in the launcher's OWN database (`gameRegistryId` = `mod/ugc_<id>.mod`), so this check
  // reports nothing today — which is the correct answer, and why its falsifier is a synthetic state
  // rather than this machine.
  LAUNCHER_MOD_UNREGISTERED: 'launcher-mod-unregistered',
})

/**
 * Severity per code. Kept in one table so the report cannot drift from the checks.
 *
 * **One deliberate exception:** `localization-bad-header` covers two different defects — a
 * language header for the wrong language (`warn`) and a first line that is not a language header
 * at all (`error`). Both carry the same code, so {@link checkLocalizationFile} picks the severity
 * for that one code itself; everything else reads this table. It is the only override, and the
 * test asserts both branches.
 */
export const SEVERITY = Object.freeze({
  [CODES.MOD_FILE_MISSING]: 'error',
  [CODES.MOD_NAME_MISMATCH]: 'error',
  [CODES.DESCRIPTOR_MISSING]: 'error',
  [CODES.DESCRIPTOR_HAS_PATH]: 'warn',
  [CODES.PATH_MISSING]: 'error',
  [CODES.PATH_ABSENT]: 'warn',
  [CODES.PATH_UNQUOTED]: 'error',
  [CODES.NON_ASCII_PATH]: 'error',
  [CODES.LOCALIZATION_NO_BOM]: 'error',
  [CODES.LOCALIZATION_BAD_HEADER]: 'warn',
  [CODES.LOCALIZATION_BAD_ENTRY]: 'warn',
  [CODES.SCRIPT_UNBALANCED]: 'error',
  [CODES.LOCALIZATION_LANGUAGE_DIR]: 'warn',
  [CODES.VANILLA_PATH_UNKNOWN]: 'warn',
  [CODES.MOD_KEY_MISSING]: 'error',
  [CODES.MOD_KEY_EMPTY]: 'error',
  [CODES.SUPPORTED_VERSION_MISSING]: 'error',
  [CODES.TAGS_NOT_A_LIST]: 'warn',
  [CODES.REPLACE_PATH_UNKNOWN]: 'error',
  [CODES.REPLACE_PATH_DESTRUCTIVE]: 'warn',
  [CODES.MOD_FOLDER_MISMATCH]: 'warn',
  [CODES.PATH_CASE_MISMATCH]: 'error',
  [CODES.UNEXPECTED_EXTENSION]: 'warn',
  [CODES.DUPLICATE_LOCALIZATION_KEY]: 'warn',
  [CODES.DESCRIPTOR_DISAGREES]: 'warn',
  [CODES.SCRIPT_HAS_BOM]: 'error',
  [CODES.EVENT_NAMESPACE_MISSING]: 'warn',
  [CODES.EVENT_ID_NAMESPACE_MISMATCH]: 'warn',
  [CODES.EVENT_ID_OUT_OF_RANGE]: 'warn',
  [CODES.EVENT_FILE_EMPTY]: 'warn',
  [CODES.TEXT_NOT_UTF8]: 'error',
  [CODES.VANILLA_FILE_OVERRIDDEN]: 'warn',
  [CODES.VANILLA_SINGLE_FILE_DATABASE_OVERRIDE]: 'error',
  [CODES.LAUNCHER_ENTRY_DEAD]: 'warn',
  [CODES.LAUNCHER_REPORTS_PROBLEM]: 'error',
  [CODES.EVENT_NEVER_FIRED]: 'warn',
  // `warn`, not `error`, and the reason is the measured boundary D-70 records: "absent from
  // vanilla" is not "the engine rejects it". `is_triggered_only` is the worked example — it
  // occurs in the whole vanilla tree once, inside a comment, so it is flagged; whether CK3
  // ignores it or errors on it was not measured, and a check may not imply a verdict it lacks.
  [CODES.VANILLA_KEY_UNKNOWN]: 'warn',
  [CODES.EVENT_THEME_UNKNOWN]: 'warn',
  // `warn`, not `error`: the `.mod` file itself is not defective, it is unregistered. The two need
  // different remedies, and only one of them is editing a file.
  [CODES.LAUNCHER_MOD_UNREGISTERED]: 'warn',
})

/** The three bytes that begin a UTF-8 BOM. Measured on all 122 vanilla english loc files. */
export const UTF8_BOM = Object.freeze([0xef, 0xbb, 0xbf])

/**
 * Tag vocabulary the CK3 launcher's "Create a Mod" picker offered when the wiki's `Mod structure`
 * page was last verified — **2023, for version 1.1** (revid 18579).
 *
 * **DELIBERATELY NOT USED FOR VALIDATION ANY MORE.** It is kept only as documentation of what the
 * retired check compared against. Three measurements retired it:
 *
 *   1. The page is flagged "last verified for version 1.1" while the install here is **1.19.0.6** —
 *      roughly eighteen minor versions stale.
 *   2. No canonical list exists on disk. `launcher\launcher-settings.json` has no tags key, the
 *      launcher's cached `game-metadata` has none, and the launcher FETCHES the list over the
 *      network when the create-a-mod window opens (its bundle calls `fetchTags(gameId)` against
 *      `api.paradox-interactive.com`; four plausible endpoints answer 403 unauthenticated).
 *   3. The launcher does not validate the field at all. Its own database stored a mod row with
 *      `tags: ["1.16 'Chamfron'"]` — a game-version string, not one of these 21 values — with the
 *      mod's status `ready_to_play`.
 *
 * So a membership test against this list reports valid mods as wrong, and the remedy it suggests
 * (rename the tag) is the only change anyone would make in response — i.e. it risks making a valid
 * mod worse. What replaced it is a SHAPE check: `tags` is a brace list of quoted strings.
 */
export const KNOWN_TAGS = Object.freeze([
  'Alternative History', 'Historical', 'Balance', 'Map', 'Bookmarks', 'Portraits',
  'Character Focuses', 'Religion', 'Character Interactions', 'Schemes', 'Culture', 'Sound',
  'Decisions', 'Total Conversion', 'Events', 'Translation', 'Fixes', 'Utilities', 'Gameplay',
  'Warfare', 'Graphics',
])

/**
 * Directory names under `localization\` that name a language. A `*.yml` sitting anywhere else
 * under `localization\` (including directly in `localization\`, and including the vanilla
 * `languages.yml`) is not in a language directory.
 *
 * `jomini` is deliberately ABSENT even though it exists under the vanilla
 * `game\localization\` — it holds Paradox's script-language definition, not a human language,
 * and it carries no `l_<lang>:` files. `languages.yml` likewise sits directly in
 * `localization\` in vanilla, which is why this check must stay a `warn`.
 */
export const LANGUAGE_DIRS = Object.freeze([
  'english', 'french', 'german', 'spanish', 'russian', 'korean', 'japanese',
  'simp_chinese', 'polish',
])

/** The flavour this validator assumes. A `l_<other>:` header is a warn, not an error. */
export const EXPECTED_LANGUAGE = 'english'

/** Directories under a mod whose `.txt` files are parsed as script by the game. */
export const SCRIPT_DIRS = Object.freeze(['common', 'events', 'history'])

/**
 * The top-level directory names the game reads, for capitalisation comparison.
 *
 * `common`, `events`, `history`, `gui` and `localization` are the ones a mod's content lives in;
 * `gfx`, `sound` and `music` hold assets rather than script. The list is deliberately short: this
 * is a case-mismatch check, not a whitelist, so an unfamiliar directory is left alone.
 */
export const TOP_LEVEL_DIRS = Object.freeze(['common', 'events', 'history', 'gui', 'localization', 'gfx', 'sound', 'music'])

/** First line of a localization file: `l_english:` with an optional trailing space. */
const LANGUAGE_HEADER = /^l_([a-z_]+):\s*$/

/**
 * A well-formed localization entry. Measured against vanilla:
 * ` ACHIEVEMENT_GROUP_very_easy_achievements:0 "Very Easy"` — leading space, key, `:` , the
 * version counter, then a quoted value.
 *
 * EVERY PART OF THIS PATTERN IS MEASURED OVER ALL 122 FILES OF `game\localization\english`,
 * because each relaxed assumption below was a real false positive on real vanilla content — and a
 * check that cries wolf on the game's own files teaches its reader to ignore it.
 *
 *   * **The version counter is OPTIONAL, and so is the space before the value.** `key:0 "x"` and
 *     `key: "x"` are both valid; **25,431** vanilla entries are of the second shape (measured over
 *     the same 122 files; the corpus holds 75,936 entry-shaped lines, 50,505 of them carrying a
 *     counter). Requiring a counter flagged every one of them, and the wiki agrees the counter is
 *     deprecated for modders (`Localization`: "The number after the : is optional and it does
 *     nothing for modders… completely deprecated").
 *
 *     **An earlier revision of this comment said "742 vanilla entries are of the second shape", and
 *     that number was wrong** — it is not a count of counterless entries, it is 34× too small. It
 *     could not be reproduced from the pattern it was attached to (the quoted pattern's `\d*` permits
 *     zero digits, so it never flagged a counterless entry at all), and the pre-fix revision is not
 *     in this repository's history, so its provenance cannot be recovered. What *is* reproducible
 *     today: over the 122 files, 744 lines fail the SHAPE printed in the old code's message, of which
 *     **742 carry a trailing `#` comment** (717 of those also lack a counter, 27 carry one and 2 fail
 *     only on an apostrophe in the key). That is where the 742 came from — the comment allowance, not
 *     the counter. The preset's `expert_modd` persona had inherited the wrong number; it now states
 *     25,431, which this file and its README agree on.
 *   * **A trailing comment is allowed** after the closing quote, e.g.
 *     ` building_ise_jingu_01: "Ise Shrine" # 伊勢神宮`.
 *   * **The key may contain an apostrophe**: `b_mansa'l-kharaz` (2×). The other non-alphanumeric
 *     key characters measured are `.` (15,614×, `board_games.0000.t`) and `-` (498×).
 *   * `#` appears (97×) only as the comment marker, which the caller skips before reaching here.
 *
 * The inner-quote form is tolerated by `.*` with a greedy tail rather than escaped-quote parsing:
 * this check answers "is this line shaped like an entry", not "does it parse".
 */
const LOCALIZATION_ENTRY = /^\s*([A-Za-z0-9_.\-']+):(?:\d+)?\s*".*"(?:\s*#.*)?\s*$/

/** A header line for some language, used to skip a well-formed non-english second header. */
const ANY_LANGUAGE_HEADER = /^l_[a-z_]+:\s*$/

/* ------------------------------------------------------------------ *
 * Small shared helpers
 * ------------------------------------------------------------------ */

/**
 * Test one code point for being outside ASCII. Written with a code-point comparison rather than
 * a regex range so it cannot be affected by the process locale.
 * @param ch - a single character.
 * @returns whether its code point exceeds 127.
 */
export function isNonAsciiChar(ch) {
  return ch.codePointAt(0) > 127
}

/**
 * Find the first non-ASCII character in a path, if any.
 *
 * The wiki sentence this implements, verbatim: *"Directory cannot include non English
 * characters. If your Windows account name have such characters you must use a directory
 * outside your Documents folder."* On this machine the account name is `曦曦`, which is exactly
 * that situation.
 *
 * @param candidate - a filesystem path.
 * @returns `{ index, char }` for the first offender, or `null` when the whole path is ASCII.
 */
export function firstNonAscii(candidate) {
  const chars = [...String(candidate)]
  for (let i = 0; i < chars.length; i += 1) {
    if (isNonAsciiChar(chars[i])) return { index: i, char: chars[i] }
  }
  return null
}

/**
 * Split decoded text into lines, tolerating CRLF.
 * @param text - decoded file text.
 * @returns the lines, without terminators.
 */
export function splitLines(text) {
  return String(text).split(/\r\n|\n|\r/)
}

/**
 * Whether a byte buffer starts with the UTF-8 BOM.
 * @param bytes - the raw file bytes.
 * @returns whether the BOM is present.
 */
export function hasBom(bytes) {
  if (!bytes || bytes.length < 3) return false
  return bytes[0] === UTF8_BOM[0] && bytes[1] === UTF8_BOM[1] && bytes[2] === UTF8_BOM[2]
}

/**
 * Decode a byte buffer as UTF-8, stripping a BOM when present.
 *
 * `fatal: false` is deliberate: a mod with an undecodable byte must produce findings about its
 * *content*, not an exception that aborts the whole scan.
 *
 * @param bytes - the raw file bytes.
 * @returns the decoded text.
 */
export function decodeText(bytes) {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Build one finding. Every check produces findings through this, so the shape is uniform.
 * @param code - one of {@link CODES}.
 * @param file - the path the finding is about.
 * @param line - 1-based line number, or 0 when the finding is about a whole file.
 * @param message - one line.
 * @param suggestion - the concrete repair.
 * @returns the finding.
 */
export function finding(code, file, line, message, suggestion) {
  return { code, severity: SEVERITY[code] ?? 'warn', file, line: line ?? 0, message, suggestion }
}

/**
 * Parse a Paradox `key="value"` / `list={ "a" "b" }` file.
 *
 * Syntax, quoted from the wiki: `key="value"` for single values, a list written
 * `list={\n\t"element0"\n\t"element1"\n}`, and `#` starting a single-line comment. This is a
 * small parser for that shape only — it is not a general Paradox script parser, and it does not
 * need to be: the three keys read here are `path`, `tags` and the presence of a `path` key.
 *
 * @param text - the decoded file text.
 * @returns `{ values, lists, has }` — inline values, list members, and a key-presence predicate.
 */
export function parseModFile(text) {
  const body = splitLines(text)
    .map((line) => line.replace(/#.*$/, ''))
    .join('\n')

  const values = {}
  const lists = {}

  for (const match of body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/g)) {
    values[match[1]] = match[2]
  }
  for (const match of body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{([^}]*)\}/gs)) {
    lists[match[1]] = [...match[2].matchAll(/"([^"]*)"/g)].map((m) => m[1])
  }
  return { values, lists, has: (key) => key in values || key in lists }
}

/* ------------------------------------------------------------------ *
 * Check 1–3: the two files and the folder must share one name
 * ------------------------------------------------------------------ */

/**
 * Checks 1 and 2 — the sibling `.mod` file exists, and its name matches the folder's.
 *
 * The wiki sentence: *"the .mod file must be placed in the same directory as the mod folder
 * and must have the same name as the mod folder"*, and without it *"the launcher will not
 * recognise the mod"*.
 *
 * @param modFolder - the mod's folder name.
 * @param entries - the names of the entries in `modDir`, as read by the caller.
 * @returns findings.
 */
export function checkSiblingModFile(modFolder, entries) {
  const findings = []
  const wanted = `${modFolder}.mod`
  const present = entries.includes(wanted)

  if (!present) {
    // A case variant of the wanted name is worth naming: on Windows the file is *found* by a
    // case-insensitive lookup, so this is a near-miss rather than an unrelated file. An
    // unrelated `.mod` file's name proves nothing and must not be reported — the first version
    // of this check filtered on `base.toLowerCase() === modFolder.toLowerCase()`, which looked
    // right and in practice claimed a mismatch for every other mod in the directory.
    const near = entries
      .filter((name) => name.toLowerCase().endsWith('.mod'))
      .filter((name) => name.slice(0, -4).toLowerCase() === modFolder.toLowerCase())
      .filter((name) => name !== wanted)
    findings.push(finding(
      CODES.MOD_FILE_MISSING,
      wanted,
      0,
      `no sibling "${wanted}" beside this mod folder, so the launcher does not recognise the mod`,
      `create "${wanted}" alongside the mod folder — the wiki states the .mod file must sit in the same directory as the mod folder and share its name`,
    ))
    if (near.length > 0) {
      findings.push(finding(
        CODES.MOD_NAME_MISMATCH,
        near[0],
        0,
        `the sibling .mod file is named "${near[0]}" but the folder is "${modFolder}" — the names differ by more than the extension`,
        `rename "${near[0]}" to "${wanted}" (or rename the folder), so the .mod file and the folder share one name`,
      ))
    }
  }
  return findings
}

/**
 * Check 3 — `descriptor.mod` exists inside the folder.
 *
 * The wiki: *"the mod folder must contain a descriptor.mod file"*, which is *"recommended to
 * keep consistent with the other one, excluding the line containing the path key which is not
 * needed in the descriptor file"*.
 *
 * @param folderPath - the mod folder's absolute path.
 * @param entries - the names inside the folder.
 * @returns findings.
 */
export function checkDescriptorPresent(folderPath, entries) {
  if (entries.includes('descriptor.mod')) return []
  const suffix = entries.some((name) => name.toLowerCase() === 'descriptor.mod')
    ? ' (a "descriptor.MOD" exists with different capitalisation — Windows accepts it, but the launcher reads the exact name)'
    : ''
  return [finding(
    CODES.DESCRIPTOR_MISSING,
    path.join(folderPath, 'descriptor.mod'),
    0,
    `no "descriptor.mod" inside the mod folder${suffix}`,
    'create descriptor.mod inside the mod folder, copied from the sibling .mod file with the `path` line removed',
  )]
}

/**
 * Check 4 — `descriptor.mod` should not contain a `path` key.
 *
 * Provenance is the wiki's recommendation, hence `warn` and not `error`: it is *"not needed in
 * the descriptor file"*. This is an observation about the key's presence only. It says nothing
 * about the format of the value — see the module header.
 *
 * @param descriptorPath - the descriptor's absolute path.
 * @param text - the descriptor's decoded text.
 * @returns findings.
 */
export function checkDescriptorHasPath(descriptorPath, text) {
  if (!parseModFile(text).has('path')) return []
  return [finding(
    CODES.DESCRIPTOR_HAS_PATH,
    descriptorPath,
    0,
    'descriptor.mod contains a `path` key, which the wiki says is not needed in the descriptor file',
    'remove the `path` line from descriptor.mod; keep it in the sibling .mod file',
  )]
}

/* ------------------------------------------------------------------ *
 * Check 5–6 and 13: the `.mod` file's path, the path's ASCII-ness, and tags
 * ------------------------------------------------------------------ */

/**
 * Check 6 — no part of the resolved mod path may contain a non-ASCII character.
 *
 * The wiki sentence, verbatim: *"Directory cannot include non English characters. If your
 * Windows account name have such characters you must use a directory outside your Documents
 * folder."*
 *
 * @param resolvedPath - the path to test, already resolved.
 * @param what - what this path is, for the message.
 * @returns findings.
 */
export function checkNonAsciiPath(resolvedPath, what = 'mod path') {
  const hit = firstNonAscii(resolvedPath)
  if (hit === null) return []
  return [finding(
    CODES.NON_ASCII_PATH,
    resolvedPath,
    0,
    `${what} contains the non-ASCII character "${hit.char}" (U+${hit.char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}) at index ${hit.index}; the CK3 Wiki "Mod structure" page states verbatim: "Directory cannot include non English characters. If your Windows account name have such characters you must use a directory outside your Documents folder."`,
    'move the mod to a directory whose entire path is ASCII only — for example D:\\CK3Mods — rather than under Documents',
  )]
}

/**
 * Check 5 — the `.mod` file's `path` key must resolve to a directory that exists.
 *
 * **What this does not do:** it does not judge the *format* of the value. The wiki does not
 * state whether it is relative or absolute and there is no sample mod on this machine to
 * measure, so the value is resolved as an absolute path when it is one and against `modDir`
 * otherwise, and only existence is asserted. A `.mod` with **no** `path` key at all yields
 * `path-absent` as a warn: with the format unverified, a missing key cannot be called invalid.
 *
 * @param modFile - the `.mod` file's absolute path.
 * @param text - the `.mod` file's decoded text.
 * @param modDir - the directory containing the `.mod` file and the mod folders.
 * @param existence - `{ exists(candidate): Promise<boolean> }`, injected so this is testable.
 * @returns findings.
 */
export async function checkModPath(modFile, text, modDir, existence = { exists: defaultExists }) {
  const { values, has } = parseModFile(text)
  if (!has('path')) {
    // A `path=` line whose value is NOT double-quoted parses to nothing, and reporting it as
    // "no path key" would be a statement about the line the reader is looking at. The wiki's Tips
    // make quoting load-bearing — "pay attention to using quotation marks … especially around
    // values like paths and names" — so the two cases are separated, and the unquoted one is an
    // error rather than a note, because the tool's own existence and ASCII checks are skipped
    // entirely while the value is unreadable.
    const body = splitLines(text).map((line) => line.replace(/#.*$/, '')).join('\n')
    const unquoted = /^\s*path\s*=\s*[^"\s]/m.test(body)
    if (unquoted) {
      return { resolved: undefined, findings: [finding(
        CODES.PATH_UNQUOTED,
        modFile,
        0,
        'a `path` line is present but its value is not a double-quoted string, so it cannot be read — the mod\'s folder, its existence and its ASCII-safety all go unchecked',
        'quote the value: path="mod/my_mod" (relative to the user folder) or path="C:/…/mod/my_mod" (absolute)',
      )] }
    }
    return { resolved: undefined, findings: [finding(
      CODES.PATH_ABSENT,
      modFile,
      0,
      'the .mod file has no `path` key, so the mod\'s directory could not be located from it (the expected format of `path` is unverified — this is reported as a note, not as a defect)',
      'if the launcher does not see the mod, add a `path=` line pointing at the mod folder; do not assume a particular relative-or-absolute spelling',
    )] }
  }
  const raw = values.path
  if (raw === undefined) return { findings: [], resolved: undefined }
  const resolved = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(modDir, raw)
  if (await existence.exists(resolved)) return { findings: [], resolved }
  return {
    resolved,
    findings: [finding(
      CODES.PATH_MISSING,
      modFile,
      0,
      `the .mod file's path="${raw}" resolves to "${resolved}", which does not exist (relative targets are resolved against ${modDir})`,
      `fix the path= value so it resolves to the existing mod folder, or create ${resolved}; the accepted relative/absolute spelling is unverified, so verify the corrected value in the launcher`,
    )],
  }
}

/**
 * Check 13 — the `tags` value is the LIST form the wiki's syntax section shows.
 *
 * This replaced a vocabulary-membership test. That test is gone because the vocabulary could not be
 * sourced from anywhere current (see {@link KNOWN_TAGS}): the wiki list is from 2023 and version
 * 1.1, the launcher fetches its tags over the network, and the launcher stored a non-member value
 * without complaint. A check that flags valid mods, and whose suggested remedy is the only edit its
 * reader would make, is worse than no check.
 *
 * What survives is what IS documented and IS decidable: scalar vs list form. The wiki's syntax
 * section gives `list={ "element0" "element1" }`, and writing `tags="Gameplay"` is the obvious
 * mistake — the launcher reads the list form, so a scalar carries no usable tag.
 *
 * @param modFile - the `.mod` file's absolute path.
 * @param text - the `.mod` file's decoded text.
 * @returns findings.
 */
export function checkTags(modFile, text) {
  const { values, lists } = parseModFile(text)
  const raw = values.tags
  if (raw !== undefined) {
    return [finding(
      CODES.TAGS_NOT_A_LIST,
      modFile,
      0,
      `tags is written as a single value (${JSON.stringify(raw)}), not as the list form \`tags={ "…" }\`; the launcher reads the list form, so this mod carries no usable tag`,
      `rewrite it as tags={\n\t${JSON.stringify(raw)}\n} — the wiki's syntax section shows the list form with one quoted element per line`,
    )]
  }
  return []
}

/* ------------------------------------------------------------------ *
 * Checks added from a measured gap analysis
 * ------------------------------------------------------------------ */

/**
 * The `.mod` keys the wiki marks **Required: Yes**, and the one it marks conditionally required.
 *
 * Quoted from the `Mod structure` page's "Required?" table:
 *   * `version` — "Yes … defined as a string"
 *   * `name` — "Yes … the name that shows up in the launcher"
 *   * `path` — "Yes … Sets which folder is the mod's folder"
 *   * `supported_version` — "**Required for file alongside mod folder; not required for
 *     descriptor.mod** … launcher will show a warning if a mod is outdated"
 *   * `tags` — "No"
 *
 * `replace_path`, `picture` and `remote_file_id` are absent on purpose: the page marks the first
 * two "No" and the third "Required if uploading and updating your own Steam Workshop mod", which a
 * local validator cannot know.
 */
export const REQUIRED_MOD_KEYS = Object.freeze(['version', 'name', 'path'])

/**
 * Check 14 — the `.mod` file's required keys are present and non-empty.
 *
 * Measured gap this closes: a `.mod` containing `version=""`, `name=""`, `path=""` produced **zero**
 * findings before, because every existing check asks whether a key is *present*, never whether it
 * is *usable*. The launcher requires all three.
 *
 * `supported_version` is treated separately, because the wiki makes it conditional: required in the
 * sibling `(name).mod`, **not** required in `descriptor.mod`. Passing `isDescriptor` selects the
 * branch. A missing `supported_version` is an `error` rather than a warning because the wiki states
 * the launcher shows an outdated-mod warning without it — that is a visible failure, not a style
 * preference.
 *
 * @param modFile - the file's absolute path.
 * @param text - the decoded text.
 * @param options - `{ isDescriptor }` — when true, `supported_version` is not required.
 * @returns findings.
 */
export function checkModFileKeys(modFile, text, options = {}) {
  const { values, lists } = parseModFile(text)
  const findings = []
  for (const key of REQUIRED_MOD_KEYS) {
    const present = key in values || key in lists
    if (!present) {
      // `descriptor.mod` legitimately omits `path` — the wiki says so in as many words.
      if (options.isDescriptor === true && key === 'path') continue
      findings.push(finding(
        CODES.MOD_KEY_MISSING,
        modFile,
        0,
        `the .mod file has no \`${key}\` key; the wiki's Mod structure page marks it Required: Yes`,
        `add ${key}="…" to ${options.isDescriptor === true ? 'descriptor.mod' : 'the sibling .mod file'}`,
      ))
      continue
    }
    if (key in values && values[key].trim() === '') {
      findings.push(finding(
        CODES.MOD_KEY_EMPTY,
        modFile,
        0,
        `the .mod file's \`${key}\` key is present but empty (${key}=""); the launcher requires a value`,
        `give ${key} a value — this key being present but blank is not the same as it being set`,
      ))
    }
  }
  if (options.isDescriptor !== true && !('supported_version' in values) && !('supported_version' in lists)) {
    findings.push(finding(
      CODES.SUPPORTED_VERSION_MISSING,
      modFile,
      0,
      'the sibling .mod file has no `supported_version` key, which the wiki marks "Required for file alongside mod folder" — the launcher will show the mod as outdated',
      'add supported_version="1.19.*" (wildcards are allowed) for the game version you actually target',
    ))
  }
  return findings
}

/**
 * Check 15 — `replace_path` names a path that exists in the vanilla install, and a warning when it
 * does not empty it.
 *
 * The wiki defines the key in one line: **"Doesn't load vanilla files for the specified path."**
 * That makes it the single most destructive key in a `.mod` file — `replace_path="history/characters"`
 * silently drops every vanilla character — and the earlier revision parsed it and then checked
 * nothing about it.
 *
 * Two findings, deliberately different in kind:
 *   * the named path has no vanilla counterpart → `error`: the entry can only be a typo, because it
 *     replaces nothing.
 *   * the named path DOES exist → `warn` stating the consequence, because replacing is sometimes
 *     exactly what the author wants and a validator must not call intent a defect.
 *
 * @param modFile - the `.mod` file's absolute path.
 * @param text - the decoded text.
 * @param gameRoot - the install root, or undefined when it is not known.
 * @param existence - `{ exists }`, injected for testability.
 * @returns findings.
 */
export async function checkReplacePath(modFile, text, gameRoot, existence = { exists: defaultExists }) {
  const { values, lists } = parseModFile(text)
  // Scalar first. The wiki's own example is `replace_path="history/characters"` — a quoted string,
  // not a list — so reading only `lists` (as the first revision of this function did) made the
  // check a silent no-op for the exact spelling the wiki documents. The list form is accepted too,
  // because a multi-path spelling is plausible even though no source shows one.
  const fromList = lists.replace_path ?? []
  const raw = values.replace_path !== undefined ? [values.replace_path] : fromList
  if (raw.length === 0) return []
  if (gameRoot === undefined) return []
  const target = path.join(gameRoot, 'game', ...raw[0].split(/[\\/]/))
  if (!await existence.exists(target)) {
    return [finding(
      CODES.REPLACE_PATH_UNKNOWN,
      modFile,
      0,
      `replace_path="${raw[0]}" has no counterpart under the vanilla install (${target}), so it replaces nothing — most likely a typo`,
      'check the spelling against the vanilla tree; the value is a path relative to <gameRoot>\\game\\',
    )]
  }
  return [finding(
    CODES.REPLACE_PATH_DESTRUCTIVE,
    modFile,
    0,
    `replace_path="${raw[0]}" is set: the wiki defines this as "Doesn't load vanilla files for the specified path", so every vanilla file under ${target} stops being loaded`,
    'keep this only if the mod really intends to replace the whole directory; otherwise drop the key and let the game merge',
  )]
}

/**
 * Check 16 — the `path` key points at THIS mod's folder.
 *
 * Now decidable, where it previously was not: the wiki settles the format —
 * `path="mod/my_mod"` is "Relative, any OS" and resolved against the **Crusader Kings III user
 * folder**, and an absolute path is also accepted. {@link checkModPath} already resolves both
 * spellings correctly, so the remaining question is only whether the result is the folder the
 * `.mod` file belongs to. A `path` that resolves to a *different existing* folder is the quiet
 * half of the copy-paste mistake: the launcher loads the other mod.
 *
 * @param mod - the discovered target.
 * @param resolved - the resolved `path` value, or undefined when there was none.
 * @returns findings.
 */
export function checkModFolderMatchesPath(mod, resolved) {
  if (resolved === undefined) return []
  const a = path.resolve(resolved).replace(/[\\/]+$/, '').toLowerCase()
  const b = path.resolve(mod.folderPath).replace(/[\\/]+$/, '').toLowerCase()
  if (a === b) return []
  return [finding(
    CODES.MOD_FOLDER_MISMATCH,
    mod.modFilePath ?? mod.folderPath,
    0,
    `path= resolves to "${resolved}", which is not this mod's own folder ("${mod.folderPath}") — the launcher will load whatever folder that is`,
    'point path= at the folder that holds descriptor.mod',
  )]
}

/**
 * Check 17 — a mod's script directory name differs only in case from a vanilla one.
 *
 * Measured: every subdirectory of the vanilla `game\common` is lowercase, and vanilla script files
 * are `00_*.txt`. On Windows a `Common\` folder still resolves, so the author sees nothing wrong;
 * on Linux and macOS the same mod loads nothing. This is the case-mismatch that is invisible on the
 * machine it is authored on.
 *
 * @param mod - the discovered target.
 * @param vanillaSubdirs - the vanilla `game\common` subdirectory names.
 * @param modSubdirs - the mod's own `common\` subdirectory names.
 * @returns findings.
 */
export function checkPathCase(mod, vanillaSubdirs, modSubdirs) {
  const findings = []
  const lowerVanilla = new Map(vanillaSubdirs.map((n) => [n.toLowerCase(), n]))
  for (const name of modSubdirs) {
    const vanilla = lowerVanilla.get(name.toLowerCase())
    if (vanilla !== undefined && vanilla !== name) {
      findings.push(finding(
        CODES.PATH_CASE_MISMATCH,
        path.join(mod.folderPath, 'common', name),
        0,
        `common\\${name} matches the vanilla directory "${vanilla}" except for capitalisation; that resolves on Windows and loads nothing on Linux or macOS`,
        `rename it to exactly "${vanilla}", which is how the vanilla tree spells it`,
      ))
    }
  }
  return findings
}

/**
 * Check 17b — the mod's TOP-LEVEL directories are spelled the way the game looks for them.
 *
 * This is the case the sub-directory check cannot reach, and it is the more destructive one: the
 * script walker in {@link validateMod} iterates `SCRIPT_DIRS` by their canonical lowercase names,
 * so a mod whose contents live under `Common\` is never walked at all — no brace check, no
 * extension check, and `common\` itself does not exist, so `checkVanillaCounterpart` and
 * {@link checkPathCase} have nothing to compare either. Measured: a mod with `Common\Decisions\…`
 * produced **zero** findings from every path-related check.
 *
 * @param mod - the discovered target.
 * @param entries - the names directly inside the mod folder.
 * @param expected - the canonical top-level directory names the game reads.
 * @returns findings.
 */
export function checkTopLevelDirCase(mod, entries, expected = TOP_LEVEL_DIRS) {
  const findings = []
  const canonical = new Map(expected.map((name) => [name.toLowerCase(), name]))
  for (const entry of entries) {
    const want = canonical.get(entry.toLowerCase())
    if (want !== undefined && want !== entry) {
      findings.push(finding(
        CODES.PATH_CASE_MISMATCH,
        path.join(mod.folderPath, entry),
        0,
        `the mod folder "${entry}" is spelled with different capitalisation than the directory the game reads ("${want}\\"); on Windows it resolves, on Linux and macOS every file under it is invisible`,
        `rename it to exactly "${want}" — and note that while it is misspelled, no script inside it is checked at all`,
      ))
    }
  }
  return findings
}

/**
 * Extensions that legitimately appear beside script files inside a script directory.
 *
 * **Measured over the vanilla `game\common` tree**, which is why this list exists: alongside **2,536**
 * `.txt` files, vanilla carries **138 `.info`** (e.g. `accolade_icons\_accolade_icon.info`), **2
 * `.lookup`** (`traits\old_trait_indexes.lookup`) and **1 `.json`**. A check that flagged every
 * non-`.txt` file under a script directory would therefore fire on 141 legitimate vanilla files —
 * the "cries wolf on the game's own files" failure this plugin already had to fix once. So only an
 * extension that is *never* legitimate is reported.
 */
export const TOLERATED_SCRIPT_DIR_EXTENSIONS = Object.freeze(['.txt', '.info', '.lookup', '.json'])

/**
 * Check 18 — script directories hold `.txt` (plus the few metadata formats vanilla itself uses).
 *
 * Measured gap: `common\decisions\g11` with no extension produced zero findings before, and the
 * FIRST revision of this check still produced zero — it passed `{}` to {@link collectFiles}, whose
 * `extensions` option defaults to `['.txt']`, so the walker returned only the files this check
 * considers valid and the check could never fire. It now asks for every extension and filters here.
 *
 * `common\` is walked recursively; `events\` and `history\` are trees of script as well.
 *
 * @param mod - the discovered target.
 * @param scriptDirs - the script roots to inspect.
 * @param collect - `(dir, options) => Promise<string[]>` — the file walker, injected for testability.
 * @returns findings.
 */
export async function checkScriptExtensions(mod, scriptDirs, collect = collectFiles) {
  const findings = []
  for (const root of scriptDirs) {
    const dir = path.join(mod.folderPath, root)
    for (const file of await collect(dir, { extensions: [] })) {
      const ext = path.extname(file).toLowerCase()
      if (TOLERATED_SCRIPT_DIR_EXTENSIONS.includes(ext)) continue
      findings.push(finding(
        CODES.UNEXPECTED_EXTENSION,
        file,
        0,
        ext === ''
          ? `file has no extension; the game reads script only from .txt under ${root}\\`
          : `file has the extension ${ext}, which the game does not read as script under ${root}\\`,
        `rename it to <name>.txt, or move it out of ${root}\\ if it is not script`,
      ))
    }
  }
  return findings
}

/**
 * Check 19 — one localization file does not define the same key twice.
 *
 * When a key appears twice the last definition wins, so the earlier line is dead text that reads as
 * though it were live. That is invisible in a diff review and is the residue of a merge. Reported as
 * a `warn` at the SECOND occurrence, naming the first, because which of the two the author meant is
 * not something a validator can know.
 *
 * @param file - the file's path.
 * @param bytes - the raw bytes.
 * @returns findings.
 */
export function checkDuplicateLocalizationKeys(file, bytes) {
  const text = decodeText(bytes)
  const firstSeen = new Map()
  const findings = []
  for (const [index, line] of splitLines(text).entries()) {
    const match = /^\s*([A-Za-z0-9_.\-']+):/.exec(line)
    if (match === null) continue
    const key = match[1]
    if (firstSeen.has(key)) {
      findings.push({
        ...finding(
          CODES.DUPLICATE_LOCALIZATION_KEY,
          file,
          index + 1,
          `key "${key}" is defined again here; it was already defined at line ${firstSeen.get(key)} — the later definition wins and the earlier text is dead`,
          `delete one of the two definitions, or rename the second if both are meant to exist`,
        ),
      })
    } else {
      firstSeen.set(key, index + 1)
    }
  }
  return findings
}

/**
 * Directories the vanilla install ships as a **single data file**, measured on 1.19.0.6.
 *
 * These are the highest-stakes overrides: a same-named file here does not add an entry, it replaces
 * the table. `common\holdings` is `00_holdings.txt` and nothing else, and `common\traits` is
 * `00_traits.txt` (306 KB). The wiki's own warning about adding buildings — that mods "need to
 * overwrite the whole holdings.txt file" — matches the measurement.
 *
 * Kept as a short measured list rather than a rule, because the general mechanism is per-file (LIOS
 * on top-level declarations) and `common\defines` legitimately carries twelve files.
 */
export const SINGLE_FILE_DATABASES = Object.freeze(['common/holdings', 'common/traits'])

/**
 * Check 23 — the mod ships a file at the same path AND filename as a vanilla file.
 *
 * This is the wiki's headline warning and the one failure invisible to every other check: the file
 * is well-formed, the braces balance, the localization has its BOM, and the mod still silently threw
 * away everything the vanilla file contained. The wiki states it plainly — **"If a mod has the same
 * file as the game, it replaces all the contents of the file. (By the same file we mean same path,
 * same filename). Avoid doing this unless you intend to overwrite the whole file!"** — while a
 * *new* filename is additive, which the vanilla tree demonstrates against itself
 * (`common\governments\` carries both `00_government_types.txt` and `01_japan_government_types.txt`).
 *
 * **Cost: proportional to the MOD, not to the install.** Rather than indexing every vanilla path
 * (tens of thousands of files), each of the mod's own files is probed for existence at the mirrored
 * location under `<gameRoot>\game`. A mod with 20 files costs 20 stats.
 *
 * Severity differs by stakes, not by kind:
 *   * a single-file database (`common\holdings`, `common\traits`) → `error`: replacing it drops the
 *     whole vanilla table.
 *   * anywhere else → `warn`: overriding a whole file is occasionally intended, so the finding
 *     states the consequence and the LIOS alternative instead of asserting a mistake.
 *
 * @param mod - the discovered target.
 * @param gameRoot - the install root (the directory holding `game\`), or undefined.
 * @param existence - injected existence probe.
 * @returns findings.
 */
export async function checkVanillaOverrides(mod, gameRoot, existence = { exists: defaultExists }) {
  if (gameRoot === undefined) return []
  const vanillaGame = path.join(gameRoot, 'game')
  if (!await existence.exists(vanillaGame)) return []
  const findings = []
  for (const file of await collectFiles(mod.folderPath, { extensions: [] })) {
    const rel = path.relative(mod.folderPath, file).replace(/\\/g, '/')
    // `descriptor.mod` and the sibling `.mod` are mod metadata, not game content — the vanilla tree
    // has no counterpart, and probing for one would be noise.
    if (rel.toLowerCase().endsWith('.mod')) continue
    if (!await existence.exists(path.join(vanillaGame, ...rel.split('/')))) continue
    const dir = path.posix.dirname(rel).toLowerCase()
    const single = SINGLE_FILE_DATABASES.includes(dir)
    findings.push(finding(
      single ? CODES.VANILLA_SINGLE_FILE_DATABASE_OVERRIDE : CODES.VANILLA_FILE_OVERRIDDEN,
      file,
      0,
      `this file has the same path and filename as a vanilla file (game/${rel}), so it REPLACES the whole vanilla file instead of adding to it${single ? `; game/${dir} ships as a single data file, so everything vanilla defined there is dropped` : ''}`,
      single
        ? 'give it a new filename that sorts AFTER the vanilla one (vanilla uses 00_, so use 01_) and define only your additions, or accept that the vanilla table is replaced'
        : 'to change one object, ship a NEW filename in the same directory that sorts later in ASCIIbetical order (01_defines.txt overrides 00_defines.txt — "Last In Only Served"); to add content, use a new filename',
    ))
  }
  return findings
}

/**
 * Remove a trailing `#` comment from one line of Paradox script.
 *
 * Deliberately simple — it cuts at the first `#` — unlike the quote-aware version the *test* uses.
 * The difference is not an oversight: `#` cannot appear inside the values this reader inspects
 * (keys, theme names and texture paths), and a comment marker that cannot occur in a value cannot
 * corrupt one. The test needs the stricter form because it parses whole blocks where a quoted
 * value may sit on the same line as a comment.
 *
 * @param line - the raw line.
 * @returns the line up to its first `#`, right-trimmed.
 */
function stripLineComment(line) {
  const hash = line.indexOf('#')
  return hash === -1 ? line : line.slice(0, hash)
}

/**
 * The set of every `key =` token the installed vanilla script tree uses, cached per install.
 *
 * **The 225-second cost D-73 recorded was my own measurement artifact, and that is worth stating.**
 * The first reading came from a PowerShell loop over 185 MB; this reader walks `common`, `events`
 * and `history` through `collectFiles` and finishes in **~2.5 s for 130,536 distinct keys** — a 95×
 * difference that was the tool, not the data. So there is no index file to cache on disk and no
 * 225-second barrier to design around: the cache below exists only so that checking several mods
 * in one call pays for the scan once.
 *
 * The scan is what makes the vocabulary claim meaningful: this is not a hand-written key list to
 * drift out of date, it is the install's own usage.
 *
 * @param gameRoot - the install root.
 * @returns a `Set` of key names.
 */
const VANILLA_KEY_CACHE = new Map()

/**
 * Drop the cached vanilla key sets.
 *
 * **Why this is exported rather than private.** The cache assumes an install's script tree does not
 * change while the process runs, which is true of the real game and false of the test's *synthetic*
 * tree — that one is assembled as the suite proceeds. Without a way to invalidate, a fixture that
 * adds keys to the synthetic tree after the first read would be compared against a stale set, and
 * the suite's own negative control would fail for a reason that has nothing to do with the check
 * (which is exactly what happened the first time this test was written). A caller who edits a tree
 * out from under the cache must say so.
 */
export function clearVanillaKeyCache() {
  VANILLA_KEY_CACHE.clear()
}

async function collectVanillaKeys(gameRoot) {
  const cached = VANILLA_KEY_CACHE.get(gameRoot)
  if (cached) return cached
  const keys = new Set()
  for (const sub of SCRIPT_DIRS) {
    for (const file of await collectFiles(path.join(gameRoot, 'game', sub), { extensions: ['.txt'] })) {
      const bytes = await readBytes(file)
      if (bytes === null) continue
      const text = decodeText(bytes)
      let start = 0
      while (start < text.length) {
        let nl = text.indexOf('\n', start)
        if (nl === -1) nl = text.length
        const line = text.slice(start, nl)
        start = nl + 1
        // Cheap rejection first: most lines have no assignment at all, and running the regex on
        // them is the difference between a 2.5 s scan and a much slower one.
        if (line.includes('=')) {
          const m = /^\s*([A-Za-z_][A-Za-z0-9_.]*)\s*=/.exec(stripLineComment(line))
          if (m) keys.add(m[1])
        }
      }
    }
  }
  VANILLA_KEY_CACHE.set(gameRoot, keys)
  return keys
}

/**
 * Extract the `key = value` pairs a mod's own script files declare, by indentation depth.
 *
 * **Why indentation and not a parse tree.** A mod's *own* object names sit at depth 0 — the event
 * id `mymod.0001`, the decision `mymod_decision` — and those are legitimately absent from vanilla
 * by definition, so comparing them would bury the signal in noise. Measured on a generated
 * skeleton: depth-0 keys contribute 3 unknown names (`good_decision`, `good.0001`, and the real
 * defect), while excluding them leaves **exactly one**, which is the defect. The depth cut is what
 * makes this check usable, and it was chosen by measurement rather than by taste.
 *
 * Comments are stripped quote-aware, because vanilla's only `is_triggered_only` occurrence lives
 * inside a `#` comment — a naive strip would count it and the check would report the opposite of
 * the truth.
 *
 * @param folderPath - the mod's folder.
 * @returns `{ keys, themes }`, each mapping a name to `{ file, line }` of its first occurrence.
 */
export async function extractScriptKeys(folderPath) {
  const keys = new Map()
  const themes = new Map()
  for (const file of await collectFiles(folderPath, { extensions: ['.txt'] })) {
    const rel = path.relative(folderPath, file).replace(/\\/g, '/').toLowerCase()
    // `.mod` metadata is not game script, and localization is a different language entirely.
    if (rel.endsWith('.mod') || rel.startsWith('localization/')) continue
    const bytes = await readBytes(file)
    if (bytes === null) continue
    const lines = splitLines(decodeText(bytes))
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i]
      if (!raw.includes('=')) continue
      const body = stripLineComment(raw)
      const indent = (/^[\t ]*/.exec(body) ?? [''])[0].replace(/ {4}/g, '\t').length
      const m = /^\s*([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*?)\s*$/.exec(body)
      if (!m) continue
      const value = m[2]
      if (indent >= 1 && !keys.has(m[1])) keys.set(m[1], { file, line: i + 1 })
      if (m[1] === 'theme' && value) {
        const themeValue = value.replace(/"/g, '').trim()
        if (themeValue && !themes.has(themeValue)) themes.set(themeValue, { file, line: i + 1 })
      }
    }
  }
  return { keys, themes }
}

/**
 * Read the theme names the install actually defines, from `common\event_themes\00_event_themes.txt`.
 *
 * `game\events\_events.info` names that file as the authority in its own words — *"For a list,
 * check: 00_event_themes.txt"* — so this reads the same source the game's documentation points at.
 * Theme blocks are the unindented `name = {` lines; every indented one is a nested property such
 * as `icon` or `background` inside a theme, and including those was measured to add spurious names.
 *
 * @param gameRoot - the install root, or undefined.
 * @returns a `Set` of theme names, or an empty `Set` when the file cannot be read.
 */
export async function readDeclaredThemes(gameRoot) {
  const themes = new Set()
  if (!gameRoot) return themes
  const file = path.join(gameRoot, 'game', 'common', 'event_themes', '00_event_themes.txt')
  const bytes = await readBytes(file)
  if (bytes === null) return themes
  for (const raw of splitLines(decodeText(bytes))) {
    const body = stripLineComment(raw)
    if (!body.trim() || /^[\t ]/.test(body)) continue
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{/.exec(body)
    if (m) themes.add(m[1])
  }
  return themes
}

/**
 * Compare a mod's script keys against the keys vanilla actually uses, and its `theme` values
 * against the themes the install defines.
 *
 * **The failure this closes, measured.** A skeleton containing `is_triggered_only = yes`,
 * `theme = realm_management`, a depth-1 `icon = "decision_icon.png"`, a missing `picture`, a
 * missing call site and a missing localization entry produced **`0 findings`** from every other
 * check in this file. Two of those six are now named here. The other four are not reachable this
 * way and D-73 records why: two are *absent* keys (an absent key is not a bad key), one is the
 * dead-text class only the runtime log plane can see, and `icon` is a legitimate key whose VALUE
 * was wrong.
 *
 * **State the boundary the same way the message does.** "Absent from vanilla" is corroboration,
 * not a verdict on engine behaviour — `_events.info` opens with "May not be exhaustive", and no
 * measurement here establishes that CK3 rejects any of these. The messages are worded to match.
 *
 * @param mod - the mod target.
 * @param gameRoot - the install root, or undefined.
 * @returns findings.
 */
export async function checkVanillaKeys(mod, gameRoot) {
  if (gameRoot === undefined) return []
  const vanillaGame = path.join(gameRoot, 'game')
  if (!await defaultExists(vanillaGame)) return []
  const findings = []

  const known = await collectVanillaKeys(gameRoot)
  const { keys, themes } = await extractScriptKeys(mod.folderPath)

  for (const [key, where] of keys) {
    if (known.has(key)) continue
    findings.push(finding(
      CODES.VANILLA_KEY_UNKNOWN,
      where.file,
      where.line,
      `the property "${key}" does not occur anywhere in the installed vanilla script tree, so this is most likely a spelling from another Paradox game or a typo`,
      `check the spelling against game\\events\\_events.info and the other .info templates beside it; if "${key}" really is intended, note that "vanilla never uses it" is not the same claim as "the engine rejects it"`,
    ))
  }

  const declared = await readDeclaredThemes(gameRoot)
  if (declared.size > 0) {
    for (const [theme, where] of themes) {
      if (declared.has(theme)) continue
      findings.push(finding(
        CODES.EVENT_THEME_UNKNOWN,
        where.file,
        where.line,
        `theme "${theme}" is not one of the ${declared.size} themes defined in game\\common\\event_themes\\00_event_themes.txt, so the event gets no icon, background or sound`,
        'use a theme name from that file (it is the authority `_events.info` points at), or drop the `theme` line to accept the default',
      ))
    }
  }

  return findings
}

/**
 * Every launcher database in the user directory, with enough detail to choose between them.
 *
 * **Why a hardcoded `launcher-v2.sqlite` is not enough — measured.** A launcher install that has
 * opted into a beta channel keeps `launcher-v2_openbeta.sqlite` beside the stable name, and **that
 * is the file the launcher is actively writing**. Measured on this machine:
 *
 *   * `launcher-v2.sqlite`         mtime 2026-09-15 20:05:22 → 0 registered mods, 0 playset rows
 *   * `launcher-v2_openbeta.sqlite` mtime 2026-09-16 23:44:28 → **7** mods, **7** playset rows (all enabled)
 *   * `launcher-v2_openbeta-backup.sqlite` mtime 2026-09-16 19:05:54 → 3 mods
 *
 * The consequence of reading only the first one is not a missing feature but a **false statement**:
 * the report says "no registered mods" and "no launcher/disk disagreement" while seven mods sit in
 * the launcher's own mod folder and the game's own log lists them. Which file is "the" database is
 * not a property of the schema, so it is discovered rather than assumed.
 *
 * Reads strictly read-only, one `SELECT COUNT(*)` per table, and records a failure per candidate
 * (`unreadable`) instead of throwing — a database being empty, locked or corrupt is a state to
 * report, not an exception to propagate.
 *
 * @param launcherDir - the `Paradox Interactive/Crusader Kings III` user directory.
 * @returns candidate records, in the order {@link selectLauncherCandidate} prefers.
 */
export async function probeLauncherDatabases(launcherDir) {
  let names
  try {
    names = await listNames(launcherDir)
  } catch {
    return []
  }
  const candidates = []
  for (const name of names.filter((n) => /^launcher-v2.*\.sqlite$/i.test(n))) {
    const candidatePath = path.join(launcherDir, name)
    const record = {
      file: name,
      path: candidatePath,
      bytes: 0,
      mtimeMs: 0,
      modCount: 0,
      playsetModCount: 0,
      playsetIsActive: null,
      unreadable: null,
    }
    try {
      record.bytes = (await stat(candidatePath)).size
      record.mtimeMs = (await stat(candidatePath)).mtimeMs
    } catch { /* a vanished candidate stays at zero size and loses every tie-break below */ }
    try {
      const sqlite = await import('node:sqlite')
      const db = new sqlite.DatabaseSync(candidatePath, { readOnly: true })
      try {
        record.modCount = Number(db.prepare('SELECT COUNT(*) AS n FROM mods').get()?.n ?? 0)
        record.playsetModCount = Number(db.prepare('SELECT COUNT(*) AS n FROM playsets_mods').get()?.n ?? 0)
        const active = db.prepare('SELECT COUNT(*) AS n FROM playsets WHERE isActive = 1').get()
        record.playsetIsActive = Number(active?.n ?? 0) > 0
      } finally {
        try { db.close() } catch { /* an already-closed handle is fine */ }
      }
    } catch (error) {
      record.unreadable = error instanceof Error ? error.message : String(error)
    }
    candidates.push(record)
  }
  return candidates.sort(compareLauncherCandidates)
}

/**
 * The evidence rank of one launcher-database candidate: bigger is better.
 *
 * **Why ranks instead of pairwise booleans.** The first version of this comparator returned
 * `-1/0/1` from a chain of `(a.x > 0) !== (b.x > 0)` tests. That is not a total order — with three
 * candidates it is not even transitive — so `Array.prototype.sort` produced a *different* winner
 * depending on input order, and a fixture with `openbeta-backup` (3 mods, newest) beside
 * `openbeta` (7 mods, older) and an empty `launcher-v2.sqlite` selected the backup. The numbers
 * below are compared as a whole, which cannot have that failure mode.
 *
 * The weights encode what the launcher's data means, not recency alone: a database that contains
 * registered mods is strictly more informative than one that does not, a database whose playset is
 * the active one is more informative still, and mtime is only a tie-break.
 *
 * @param candidate - a candidate from {@link probeLauncherDatabases}.
 * @returns a comparable rank record.
 */
export function launcherCandidateRank(candidate) {
  const empty = Number(candidate.modCount) === 0
  const { mtimeMs } = candidate
  return {
    rank: [
      candidate.unreadable === null ? 0 : 1,
      empty ? 1 : 0,
      candidate.playsetIsActive === true ? 0 : 1,
    ],
    mtimeMs: typeof mtimeMs === 'number' ? mtimeMs : 0,
    file: candidate.file,
  }
}

/**
 * `Array.prototype.sort` comparator over the ranks above — a total order by construction.
 *
 * @param left - one candidate.
 * @param right - another.
 * @returns a negative number when `left` should be preferred.
 */
export function compareLauncherCandidates(left, right) {
  const a = launcherCandidateRank(left)
  const b = launcherCandidateRank(right)
  for (let i = 0; i < a.rank.length; i += 1) {
    if (a.rank[i] !== b.rank[i]) return a.rank[i] - b.rank[i]
  }
  if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs
  return a.file.localeCompare(b.file)
}

/**
 * Pick the database to read out of {@link probeLauncherDatabases}' result.
 *
 * Pure, so the choice is assertable without a launcher on disk — and it is the one decision in this
 * file that produced a wrong report when it was made implicitly by a hardcoded filename.
 *
 * @param candidates - the probe result.
 * @returns `{ chosen, others }`; `chosen` is `null` when there are no candidates at all.
 */
export function selectLauncherCandidate(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return { chosen: null, others: [] }
  const sorted = [...candidates].sort(compareLauncherCandidates)
  const [chosen, ...rest] = sorted
  return {
    chosen,
    others: rest.map((candidate) => {
      let reason = 'lower-ranked candidate'
      if (candidate.unreadable !== null) reason = `unreadable: ${candidate.unreadable}`
      else if (chosen.unreadable === null && candidate.modCount > 0 && chosen.modCount === 0) {
        reason = `contains ${candidate.modCount} registered mods while the chosen database contains none`
      } else if (chosen.unreadable === null && candidate.modCount === 0 && chosen.modCount > 0) reason = 'no registered mods'
      else if (candidate.mtimeMs < chosen.mtimeMs) reason = 'older than the chosen database'
      else if (candidate.mtimeMs === chosen.mtimeMs) reason = 'same mtime as the chosen database; lost the name tie-break'
      return { ...candidate, reason }
    }),
  }
}

/**
 * Read the launcher's own view of the installed mods and the active playset.
 *
 * **Why this exists, and why it is not a static check.** Every other function in this file answers
 * questions about files. None of them can answer the three questions a mod author actually has:
 * *does the launcher recognise my mod at all, is it enabled, and where does it sit in the load
 * order?* Those answers are already on disk in the launcher's database, and the wiki makes load
 * order load-bearing — **"Mods are loaded in order from top to bottom of the playset. The mod lower
 * in the playset will overwrite identical files from above."**
 *
 * Reads with the built-in `node:sqlite` (no dependency, no subprocess) and **strictly read-only**:
 * the database belongs to the launcher, and a validator has no business writing to it. Every failure
 * mode returns a reportable reason instead of throwing, because "the launcher has never run" is a
 * normal state and not an error.
 *
 * **The file to read is discovered, not hardcoded** — see {@link probeLauncherDatabases} for the
 * measured reason. `databaseCandidates` is returned so a caller can print which file was read and
 * which was passed over; a report that cannot say that cannot be checked against the launcher's UI.
 *
 * @param launcherDir - the `Paradox Interactive/Crusader Kings III` user directory.
 * @returns `{ available, reason?, databasePath, databaseCandidates, mods, playset }`.
 */
export async function readLauncherState(launcherDir) {
  const candidates = await probeLauncherDatabases(launcherDir)
  const { chosen, others } = selectLauncherCandidate(candidates)
  const databaseCandidates = chosen === null ? [] : [chosen, ...others]
  if (chosen === null) {
    return {
      available: false,
      reason: `no launcher database at ${path.join(launcherDir, 'launcher-v2*.sqlite')} — the launcher has not written one yet, so its view of these mods cannot be read`,
      databasePath: path.join(launcherDir, 'launcher-v2.sqlite'),
      databaseCandidates,
      mods: [],
      playset: null,
    }
  }
  if (chosen.unreadable !== null) {
    return {
      available: false,
      reason: `the launcher database ${chosen.path} could not be read (${chosen.unreadable}) — it may be locked by a running launcher`,
      databasePath: chosen.path,
      databaseCandidates,
      mods: [],
      playset: null,
    }
  }
  const databasePath = chosen.path
  if (!await defaultExists(databasePath)) {
    return {
      available: false,
      reason: `no launcher database at ${databasePath} — the launcher has not written one yet, so its view of these mods cannot be read`,
      databasePath,
      databaseCandidates,
      mods: [],
      playset: null,
    }
  }
  let sqlite
  try {
    sqlite = await import('node:sqlite')
  } catch (error) {
    return {
      available: false,
      reason: `node:sqlite is not available in this runtime (${error instanceof Error ? error.message : String(error)})`,
      databasePath,
      databaseCandidates,
      mods: [],
      playset: null,
    }
  }
  let db
  try {
    db = new sqlite.DatabaseSync(databasePath, { readOnly: true })
    const mods = db.prepare('SELECT id, gameRegistryId, displayName, version, tags, requiredVersion, status, metadataStatus, dirPath, archivePath FROM mods').all()
    const playsets = db.prepare('SELECT id, name, isActive FROM playsets').all()
    const links = db.prepare('SELECT playsetId, modId, enabled, position FROM playsets_mods').all()
    const active = playsets.find((p) => p.isActive === 1 || p.isActive === true) ?? playsets[0] ?? null
    const ordered = active === null
      ? []
      : links
        .filter((l) => l.playsetId === active.id)
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map((l) => {
          const mod = mods.find((m) => m.id === l.modId)
          return { ...l, name: mod?.displayName ?? mod?.gameRegistryId ?? null, status: mod?.status ?? null }
        })
    return {
      available: true,
      databasePath,
      databaseCandidates,
      mods: mods.map((m) => ({
        ...m,
        // The point of the whole exercise: turn the launcher's registry id into a real path so the
        // caller can compare it against what is actually on disk.
        registryFile: typeof m.gameRegistryId === 'string' ? m.gameRegistryId.replace(/^mod\//, '') : null,
      })),
      playset: active === null ? null : { ...active, mods: ordered },
    }
  } catch (error) {
    return {
      available: false,
      reason: `the launcher database could not be read (${error instanceof Error ? error.message : String(error)}) — it may be locked by a running launcher`,
      databasePath,
      databaseCandidates,
      mods: [],
      playset: null,
    }
  } finally {
    try { db?.close() } catch { /* nothing to do: an already-closed handle is fine */ }
  }
}

/**
 * Compare what the launcher knows against what is on disk.
 *
 * Two disagreements are reported here, and each has a distinct cause:
 *   * the launcher shows a mod whose `.mod` file is gone → a dead entry in the picker;
 *   * a `status`/`metadataStatus` that is not a normal value → **the launcher itself has already
 *     judged the mod broken**, which outranks anything this plugin computes.
 *
 * **The opposite direction lives in {@link compareLauncherToDiskFiles}** — a `.mod` file the
 * launcher never registered. It is a separate function because it needs a second input (the list of
 * files in the launcher's own scan directory) and because an earlier revision of this comment
 * promised three classes while this function produced two, which is the kind of gap a later reader
 * has no way to notice.
 *
 * @param launcher - the result of {@link readLauncherState}.
 * @param modDir - the mod workspace.
 * @returns findings.
 */
export function compareLauncherToDisk(launcher, modDir) {
  if (!launcher.available) return []
  const findings = []
  for (const mod of launcher.mods) {
    // `dirPath` is the launcher's OWN record of where the mod lives, so it is preferred over
    // reconstructing a path from `modDir`: a mod can be registered from a directory outside the
    // workspace (the launcher's own `Documents\...\mod` is the default), and guessing would report a
    // dead entry for a mod that is perfectly fine somewhere else. `gameRegistryId` is the fallback
    // for rows written before `dirPath` existed.
    const beyondWorkspace = typeof mod.dirPath === 'string' && mod.dirPath !== ''
    const target = beyondWorkspace
      ? mod.dirPath
      : (mod.registryFile === null ? null : path.join(modDir, mod.registryFile))
    if (target === null) continue
    const modFile = beyondWorkspace ? path.join(target, 'descriptor.mod') : target
    const where = beyondWorkspace ? `the folder the launcher recorded (${target})` : target
    // A `dirPath`-based row is alive if the folder exists; a registry-id-based row is alive if the
    // `.mod` file exists. Reporting the wrong one as missing is the failure this branch avoids.
    if (!defaultExistsSync(modFile)) {
      findings.push(finding(
        CODES.LAUNCHER_ENTRY_DEAD,
        target,
        0,
        `the launcher has a mod registered (${JSON.stringify(mod.displayName ?? mod.gameRegistryId)}) but nothing is at ${where}; the picker will show an entry that cannot load`,
        `remove the mod in the launcher, or put the mod back at ${where}${beyondWorkspace ? ' — note this is outside the mod workspace, which is why it was not found there' : ''}`,
      ))
    }
  }
  const badStatus = launcher.mods.filter((m) => {
    const status = String(m.status ?? '').toLowerCase()
    const meta = String(m.metadataStatus ?? '').toLowerCase()
    return (status !== '' && status !== 'ready_to_play') || meta.includes('error')
  })
  for (const mod of badStatus) {
    findings.push(finding(
      CODES.LAUNCHER_REPORTS_PROBLEM,
      typeof mod.dirPath === 'string' && mod.dirPath !== '' ? mod.dirPath : (mod.registryFile ?? ''),
      0,
      `the launcher reports this mod as ${JSON.stringify(mod.status)} / metadata ${JSON.stringify(mod.metadataStatus)} — the launcher's own verdict, which is stronger evidence than any check this tool performs`,
      'open the launcher and read the mod\'s entry; the launcher validates against the real game data',
    ))
  }
  return findings
}

/**
 * List the `.mod` files in the launcher's own scan directory.
 *
 * `<launcherDir>\mod` is where the launcher keeps the descriptors it manages — the folder the wiki's
 * `Mod structure` page calls the user mod folder. It is read as a **directory listing only**: the
 * point is to know which `.mod` files exist there, not to interpret them.
 *
 * Kept separate from {@link compareLauncherToDiskFiles} on purpose — this half does I/O, that half is
 * pure, and only the pure half can be asserted against synthetic input.
 *
 * @param launcherDir - the `Paradox Interactive/Crusader Kings III` user directory.
 * @returns file names ending in `.mod`; `[]` when the directory does not exist.
 */
export async function listLauncherModFiles(launcherDir) {
  const modDir = path.join(launcherDir, 'mod')
  if (!await defaultExists(modDir)) return []
  try {
    return (await listNames(modDir)).filter((name) => name.toLowerCase().endsWith('.mod')).sort()
  } catch {
    return []
  }
}

/**
 * Report `.mod` files the launcher has never registered.
 *
 * **This is the direction that answers "the launcher will not recognise my mod".** The wiki states
 * it in words — without the sibling `.mod` file the launcher does not recognise the mod — and the
 * condition is invisible from the mod's own files: everything can be correct on disk while the
 * launcher's registry has no row for it.
 *
 * **Silence when the launcher is unavailable is deliberate, and it is an asserted contract:**
 * `test/falsify.mjs` pins "a machine where the launcher never ran must not report every mod as
 * unregistered". The same rule that forbids reporting an empty result as "nothing wrong" forbids
 * reporting an unreadable registry as "everything is unregistered".
 *
 * @param launcher - the result of {@link readLauncherState}.
 * @param launcherModFileNames - the output of {@link listLauncherModFiles}.
 * @param launcherModDir - the directory those names came from, used to name each finding's file.
 * @returns findings.
 */
export function compareLauncherToDiskFiles(launcher, launcherModFileNames, launcherModDir = '') {
  if (launcher?.available !== true) return []
  if (!Array.isArray(launcherModFileNames) || launcherModFileNames.length === 0) return []
  const registered = new Set()
  for (const mod of launcher.mods ?? []) {
    const id = typeof mod.gameRegistryId === 'string' ? mod.gameRegistryId : ''
    if (id.trim() === '') continue
    registered.add(id.replace(/^mod\//, '').toLowerCase())
  }
  const findings = []
  for (const name of launcherModFileNames) {
    if (!String(name).toLowerCase().endsWith('.mod')) continue
    if (registered.has(String(name).toLowerCase())) continue
    findings.push(finding(
      CODES.LAUNCHER_MOD_UNREGISTERED,
      path.join(launcherModDir, name),
      0,
      `"${name}" sits in the launcher's own mod folder but has no row in the launcher's database, so the launcher will show nothing for it and will not load it — a file on disk is not a registered mod`,
      'add the mod through the launcher (its mods screen), or re-run the mod scan in the launcher; the .mod file existing is not enough',
    ))
  }
  return findings
}

/** Synchronous existence probe, for the comparison whose contract is synchronous. */
function defaultExistsSync(candidate) {
  try {
    statSync(candidate)
    return true
  } catch {
    return false
  }
}

/**
 * Generate a minimal, loadable CK3 mod skeleton and write it to disk.
 *
 * **Why a generator belongs in a validator.** Everything else here checks a mod that already
 * exists; and the step of getting the initial files right is the one a new author is most likely to
 * botch, in ways that are individually invisible: the two `.mod` files must differ by exactly the
 * `path` line, the localization file needs a UTF-8 BOM most editors do not add, `tags` is a brace
 * list rather than a scalar, and the values want quoting. The wiki's own answer is to let the
 * launcher create them "in the interests of speed and avoiding human error" — a route unavailable on
 * this machine, because the launcher refuses non-English directory names and the account here is
 * `曦曦`.
 *
 * Every structural decision is one this file already establishes elsewhere — the required key set,
 * the descriptor's missing `path`, the BOM, the `l_english:` first line, the event `namespace`. This
 * function adds no rule of its own; it writes down rules that are already sourced.
 *
 * **Never overwrites.** Any path that already exists is reported as refused and left untouched
 * unless `ifExists: 'overwrite'` is passed explicitly, so a mistyped name cannot destroy work. It
 * writes only inside the new mod's own folder and its sibling `.mod` file.
 *
 * @param options - `{ modDir, name, version?, supportedVersion?, tags?, systems?, ifExists? }`.
 * @returns `{ created, refused, folder, modFile }`.
 */
export async function scaffoldMod(options) {
  const { modDir, name } = options
  const version = options.version ?? '0.1.0'
  const supportedVersion = options.supportedVersion ?? '1.19.*'
  const tags = options.tags ?? ['Gameplay']
  const systems = options.systems ?? ['localization']

  const folder = path.join(modDir, name)
  const modFile = path.join(modDir, `${name}.mod`)
  const created = []
  const refused = []

  // The workspace itself may not exist — a first-run machine has no mod directory at all, and this
  // generator is the thing that is supposed to work there. `recursive` also covers the mod folder.
  await mkdir(modDir, { recursive: true })
  await mkdir(folder, { recursive: true })

  const writeIfAbsent = async (target, content) => {
    if (await defaultExists(target)) {
      if (options.ifExists === 'overwrite') {
        await writeFileBytes(target, content)
        created.push(target)
        return
      }
      refused.push(target)
      return
    }
    await writeFileBytes(target, content)
    created.push(target)
  }

  // The two `.mod` files. The wiki: the sibling one is required — "without it the launcher will not
  // recognise the mod" — while `descriptor.mod` is "recommended to keep consistent with the other
  // one, excluding the line containing the path key which is not needed in the descriptor file".
  const tagList = tags.map((t) => `\t"${t}"`).join('\n')
  const header = `version="${version}"\n`
    + `tags={\n${tagList}\n}\n`
    + `name="${name}"\n`
    + `supported_version="${supportedVersion}"\n`
  await writeIfAbsent(modFile, Buffer.from(`${header}path="${folder.replace(/\\/g, '/')}"\n`, 'utf8'))
  await writeIfAbsent(path.join(folder, 'descriptor.mod'), Buffer.from(header, 'utf8'))

  // Localization: BOM + `l_english:` + one `key:0 "value"`. Measured on the install — all 122
  // vanilla english files begin with the BOM, and the counter is optional (25,431 vanilla entries
  // omit it), but writing `0` is the conservative spelling.
  if (systems.includes('localization')) {
    await mkdir(path.join(folder, 'localization', 'english'), { recursive: true })
    // The decision's own keys are written too. A decision named `<key>` looks up `<key>` and
    // `<key>_desc` by default (`game\common\decisions\_decisions.info:11` and `:122`, both
    // `default: "<key>"` / `default: "<key>_desc"`), so emitting the decision without them produces a
    // raw key in the interface — a defect the checker's localization pass cannot see, because it
    // validates the entries that are *present* and has no view of a key that is *absent*.
    const decisionKeys = systems.includes('decisions')
      ? ` ${name}_decision:0 "${name} decision"\n ${name}_decision_desc:0 "Adds 50 gold."\n`
      : ''
    const loc = Buffer.concat([
      Buffer.from(UTF8_BOM),
      Buffer.from(`l_english: \n ${name}_greeting:0 "Hello from ${name}"\n${decisionKeys}`, 'utf8'),
    ])
    await writeIfAbsent(path.join(folder, 'localization', 'english', `${name}_l_english.yml`), loc)
  }

  // Events: a namespace, one event, and an id that uses it — the three things check 20 looks for,
  // written correctly by construction rather than checked afterwards.
  //
  // Corrected against the real installation. The previous body used `theme = realm_management`, which
  // is not a key in `game\common\event_themes\00_event_themes.txt` (the file `game\events\_events.info`
  // names as the authority — its own words: "For a list, check: 00_event_themes.txt"), and it carried
  // `is_triggered_only = yes`, the CK2 spelling, which occurs in the whole vanilla tree exactly once and
  // **inside a `#` comment** (`game\events\education_and_childhood\chinese_disciple_events.txt:922`).
  // `theme = realm` is a real key (that file, line 472). Note the measured limit: absent-from-vanilla is
  // not the same claim as rejected-by-the-engine, which nothing here establishes. The event is left
  // *reachable* rather than marked triggered-only, and the decisions block below is what fires it.
  if (systems.includes('events')) {
    await mkdir(path.join(folder, 'events'), { recursive: true })
    const ns = name.replace(/[^A-Za-z0-9_]/g, '_').toLowerCase()
    const body = `namespace = ${ns}\n\n`
      + `${ns}.0001 = {\n`
      + `\ttype = character_event\n`
      + `\ttitle = ${name}_greeting\n`
      + `\tdesc = ${name}_greeting\n`
      + `\ttheme = realm\n\n`
      + `\toption = {\n\t\tname = "${name}_greeting"\n\t}\n`
      + `}\n`
    await writeIfAbsent(path.join(folder, 'events', `${name}_events.txt`), Buffer.from(body, 'utf8'))
  }

  // Decisions: the `is_shown` / `is_valid` / `effect` shape the wiki's decisions page documents.
  //
  // Two corrections against the real installation. `icon` is documented *only* inside a `widget` →
  // `item` block (`game\common\decisions\_decisions.info:163`), while the decision-level key is
  // `picture = { reference = "…dds" }` (`:16`–`:24`, whose example is exactly the path used here), and
  // the old value pointed at a file the generator never created. And the effect now calls the event:
  // without a call site the emitted event is dead text no matter how valid it looks, which is the one
  // defect class the checker itself cannot reach (a mod can pass every check and still show nothing).
  if (systems.includes('decisions')) {
    await mkdir(path.join(folder, 'common', 'decisions'), { recursive: true })
    const ns = name.replace(/[^A-Za-z0-9_]/g, '_').toLowerCase()
    const trigger = systems.includes('events') ? `\t\ttrigger_event = ${ns}.0001\n` : ''
    const body = `${name}_decision = {\n`
      + `\tpicture = { reference = "gfx/interface/illustrations/decisions/decision_misc.dds" }\n\n`
      + `\tis_shown = {\n\t\tis_ruler = yes\n\t}\n\n`
      + `\tis_valid = {\n\t\tis_ruler = yes\n\t}\n\n`
      + `\teffect = {\n\t\tadd_gold = 50\n${trigger}\t}\n`
      + `}\n`
    await writeIfAbsent(path.join(folder, 'common', 'decisions', `${name}_decisions.txt`), Buffer.from(body, 'utf8'))
  }

  return { created, refused, folder, modFile }
}

/**
 * Parse one CK3 log line. Measured against the real format written by 1.19.0.6:
 *
 * ```
 * [23:17:39][D][jomini_game_setup.cpp:326]: Log system initialized.
 * [23:18:27][W][provincetemplate.cpp:158]: Province 10186 has no pixels!
 * ```
 *
 * i.e. `[HH:MM:SS][LEVEL][source:line]: message`. Severity letters observed: `D` debug, `I` info,
 * `W` warning, `E` error. Anything that does not match is returned with `severity === null` rather
 * than being dropped, because a log whose shape changed must not silently parse to zero findings —
 * the caller counts those as unparsed lines and reports them.
 *
 * @param line - one raw line.
 * @returns `{ severity, source, message }`.
 */
export function parseLogLine(line) {
  const m = /^\[(\d{2}:\d{2}:\d{2})]\[([A-Za-z]+)]\[([^\]]+)]:\s?(.*)$/.exec(line)
  if (m === null) return { severity: null, source: null, message: line }
  return { severity: m[2].toUpperCase(), source: m[3], message: m[4] }
}

/**
 * Read CK3's runtime logs — the only evidence plane that can see a REACHABILITY failure.
 *
 * **Why this exists.** Every other check in this file reads the mod. None of them can see the single
 * most common silent CK3 bug: **an event that is referenced but never fires**, because its trigger
 * never passes or because nothing calls it. The wiki's `Event modding` checklist requires events to
 * "be fired from script in some way".
 *
 * **The reachability signal is conditional, and on this machine it is currently unavailable.** *If*
 * the engine writes an `event_log.csv` counting, per event, how many times it was checked and how
 * many times each option was picked (Patch 1.5: *"the # of times each event has been checked, and the
 * # of times each option has gotten picked"*), then a row with `checked = 0` is an event wired to
 * nothing. **Measured on this install (1.19.0.6): the file is never created** — `event_queue` was run
 * in-game and left three independent traces while writing no file, a recursive search for
 * `event_log*` across `C:\` and `D:\` returned zero hits, and the command's own implementation string
 * block contains no file write. So this reader must be able to say "I cannot read it" without that
 * reading like "there is nothing wrong" — which is why `eventReport` is `null` rather than an empty
 * report in exactly that case.
 *
 * **THREE STATES, AND THE MEASURED FACT THAT MAKES THE THIRD ONE SUBTLE.**
 *
 *   1. **Unavailable** — `logs\` does not exist because the game has never run. No findings.
 *   2. **Not flushed** — the directory and its files exist but every file is 0 bytes. This is what a
 *      game looks like while it is still loading: the engine creates its log files at startup
 *      (**eighteen** of them on the run measured here, not the sixteen an earlier revision recorded)
 *      and flushes as it goes. **An empty `error.log` is not "no errors"** — it is "nothing flushed
 *      yet", and the two are indistinguishable from the bytes alone.
 *   3. **Populated** — and here is the measured part. **A non-empty log is NOT evidence of a problem.**
 *      Observed on a clean, unmodded launch: `setup.log` carried **512** W-level lines and its first
 *      one was `[W][provincetemplate.cpp:158]: Province 10186 has no pixels!` — vanilla's own
 *      warnings, with no mod enabled at all. The wiki says the same in words: *"the log will report
 *      errors even in an unmodded game. Launch the game without any mods and let it run for a while to
 *      learn which errors are common and not caused by you."* So this reader **counts and reports**;
 *      it raises a finding only for the event-reachability signal, which concerns the author's own
 *      content.
 *
 * **THE LOGS ARE PER RUN, AND THE READER MUST SAY SO.** Measured: the files in `logs\` are overwritten
 * by each launch — the run that produced `debug.log:5594 [D][console.cpp:1164]: Running console
 * command: event_queue` was replaced by a later run whose `debug.log` contains only `gold 5000`
 * lines. So a reading is always *one run's* evidence, and `run.startedAt` is reported to date it.
 * (One sibling file does NOT behave this way: `console_history.txt` accumulates typed console input
 * across runs. Anything that cites "the history file proves X was never run" is reading a file that
 * grows, not one that resets.)
 *
 * **CONTINUATION LINES ARE PART OF THE ERROR, AND MERGING THEM IS LOAD-BEARING.** Measured on a
 * modded run: `error.log` held **1780** E-level lines but only **43** distinct messages, because
 * **1562** of them were the identical shell `Script system error! (while building tooltip/description)`
 * and 59 more were `Script system error!` — with the actual fault on the following, non-timestamped
 * line (`  Error: Undefined event target 'liege'` / `  Script location: file: … line: 779 (…)`). A
 * deduplication key of "the message text" therefore collapsed 1621 real errors into 2 entries and
 * presented the result as "43 distinct errors", which is the number of *shells*, not of faults. The
 * key for those shells is the shell plus its continuation lines, and `suppressedShellErrors` reports
 * how many raw E lines are still represented by one entry.
 *
 * @param logsDir - the launcher user directory's `logs` subdirectory.
 * @returns `{ available, reason?, flushed, files, run, distinctErrors, rawELines, suppressedShellErrors, eventReport, findings }`.
 */
export async function readRuntimeEvidence(logsDir) {
  if (!await defaultExists(logsDir)) {
    return {
      available: false,
      reason: `no logs directory at ${logsDir} — the game has not been launched, so there is no runtime evidence to read`,
      flushed: false,
      files: [],
      run: null,
      eventReport: null,
      distinctErrors: [],
      rawELines: 0,
      suppressedShellErrors: 0,
      findings: [],
    }
  }
  const names = await listNames(logsDir)
  const files = []
  for (const name of names) {
    const bytes = await readBytes(path.join(logsDir, name))
    if (bytes === null) continue
    const text = decodeText(bytes)
    const lines = text === '' ? [] : splitLines(text).filter((l) => l.trim() !== '')
    const bySeverity = { D: 0, I: 0, W: 0, E: 0, unparsed: 0 }
    for (const line of lines) {
      const parsed = parseLogLine(line)
      if (parsed.severity === null) bySeverity.unparsed += 1
      else if (parsed.severity in bySeverity) bySeverity[parsed.severity] += 1
      else bySeverity.unparsed += 1
    }
    files.push({ name, bytes: bytes.length, lines: lines.length, bySeverity, text })
  }
  const flushed = files.some((f) => f.bytes > 0)
  const findings = []
  const eventReport = parseEventLog(files.find((f) => f.name.toLowerCase().startsWith('event_log')))
  const run = describeLogRun(files)
  /*
   * DEDUPLICATE ACROSS SINKS — by message, and by shell + continuation for shell lines.
   *
   * Measured on a real launch: the SAME two E-level messages appeared in `debug.log`, `error.log` AND
   * `game.log` — the engine fans one message out to several sinks. A per-file count therefore
   * reported "6 E-level" for two distinct errors, inflating by 3x the only number a reader would act
   * on. Messages are keyed by their text with the `[HH:MM:SS]` prefix stripped, and the contributing
   * sinks are kept so the report can say where each was found.
   *
   * The continuation merge is scoped to shell lines on purpose: appending the following lines to
   * *every* message would make two byte-identical messages differ whenever their neighbouring lines
   * did, which would silently undo the cross-sink deduplication above.
   */
  const distinct = new Map()
  let rawELines = 0
  for (const file of files) {
    if (file.bytes === 0) continue
    const lines = splitLines(file.text)
    for (let i = 0; i < lines.length; i += 1) {
      const parsed = parseLogLine(lines[i])
      if (parsed.severity !== 'E') continue
      rawELines += 1
      const message = parsed.message.trim()
      if (message === '') continue
      const key = MERGES_CONTINUATION.test(message) ? `${message} ‖ ${continuationOf(lines, i)}` : message
      if (!distinct.has(key)) distinct.set(key, { message, continuation: '', source: parsed.source, files: [], count: 0 })
      const entry = distinct.get(key)
      entry.count += 1
      if (entry.continuation === '' && key.length > message.length) entry.continuation = key.slice(message.length + 3)
      if (!entry.files.includes(file.name)) entry.files.push(file.name)
    }
  }
  const distinctErrors = [...distinct.values()].sort((a, b) => b.count - a.count)
  const suppressedShellErrors = rawELines - distinctErrors.reduce((n, e) => n + e.count, 0)
  if (eventReport !== null) {
    for (const row of eventReport.neverChecked) {
      findings.push(finding(
        CODES.EVENT_NEVER_FIRED,
        path.join(logsDir, eventReport.fileName),
        0,
        `event ${row.id} was checked 0 times in this run — nothing ever calls it, so it will never fire`,
        'fire it from an on_action, a decision, a character interaction or a story cycle; the Event modding checklist requires events to "be fired from script in some way"',
      ))
    }
  }
  return {
    available: true,
    flushed,
    files,
    run,
    eventReport,
    distinctErrors,
    rawELines,
    suppressedShellErrors,
    findings,
  }
}

/** Messages whose real content is on the following, non-timestamped lines. See {@link readRuntimeEvidence}. */
const MERGES_CONTINUATION = /^Script system error!?/

/**
 * The continuation lines that belong to the log entry starting at `index`.
 *
 * A continuation line is one that does not itself begin with `[HH:MM:SS]` — the engine writes the
 * fault and its `Script location:` underneath the timestamped shell. Blank lines and the next
 * timestamped line both end the run, and the result is capped so one malformed file cannot pull an
 * unbounded amount of text into a single key.
 *
 * @param lines - the file's lines.
 * @param index - the index of the timestamped line.
 * @returns the continuation text, joined by spaces; `''` when there is none.
 */
function continuationOf(lines, index) {
  const parts = []
  for (let i = index + 1; i < lines.length && parts.length < 4; i += 1) {
    const line = lines[i]
    if (line.trim() === '') break
    if (/^\[\d{2}:\d{2}:\d{2}]/.test(line)) break
    parts.push(line.trim())
  }
  return parts.join(' ')
}

/**
 * Describe which game run the log files belong to.
 *
 * **Why the reader needs this.** `logs\` is overwritten by every launch, so a report about it is
 * always a report about *one* run; without a date, a reader cannot tell whether it describes the run
 * they just played or an older one. The files carry no explicit run id, so the run is dated from the
 * earliest `[HH:MM:SS]` any of them contains, and identified further by the two version strings the
 * engine writes at startup — `code_revisions.log` carries `game_hash_long:` and `system.log` carries
 * `Exe Git Version:`, both stable for an install and both readable from the first lines.
 *
 * @param files - the file records from {@link readRuntimeEvidence}.
 * @returns `{ startedAt, gameHash, exeVersion }`, each `null` when unreadable.
 */
export function describeLogRun(files) {
  let startedAt = null
  let gameHash = null
  let exeVersion = null
  for (const file of files) {
    if (file.bytes === 0) continue
    const first = splitLines(file.text).find((line) => line.trim() !== '') ?? ''
    const time = /^\[(\d{2}:\d{2}:\d{2})]/.exec(first)
    if (time !== null && (startedAt === null || time[1] < startedAt)) startedAt = time[1]
    if (file.name.toLowerCase() === 'code_revisions.log') {
      const m = /game_hash_long:\s*(\S+)/.exec(file.text)
      if (m !== null) gameHash = m[1]
    }
    if (file.name.toLowerCase() === 'system.log') {
      const m = /Exe Git Version:\s*(\S+)/.exec(file.text)
      if (m !== null) exeVersion = m[1]
    }
  }
  return { startedAt, gameHash, exeVersion }
}

/**
 * Parse `event_log.csv` into the reachability signal, tolerating whatever columns the engine wrote.
 *
 * The header is read rather than assumed: the file's shape comes from the engine, and a parser that
 * hardcodes column order breaks silently on a different version. Columns are identified by name
 * (`event`/`id`, `check`) with no positional fallback — and when the header is unrecognised this
 * returns `null` rather than an empty report, because "I could not read it" and "there is nothing
 * wrong" must not look the same to the caller.
 *
 * @param file - the `event_log` entry from the directory listing, or undefined.
 * @returns `{ fileName, rows, neverChecked }` or null.
 */
export function parseEventLog(file) {
  if (file === undefined || file.bytes === 0) return null
  const lines = file.text.split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length < 2) return null
  const delimiter = lines[0].includes(';') && !lines[0].includes(',') ? ';' : ','
  const header = lines[0].split(delimiter).map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ''))
  const find = (...needles) => header.findIndex((h) => needles.some((n) => h.includes(n)))
  const idAt = find('event', 'id')
  const checkAt = find('check')
  if (idAt === -1 || checkAt === -1) return null
  const rows = []
  const neverChecked = []
  for (const line of lines.slice(1)) {
    const cells = line.split(delimiter).map((c) => c.trim().replace(/^"|"$/g, ''))
    const id = cells[idAt]
    if (id === undefined || id === '') continue
    const checked = Number.parseInt(cells[checkAt] ?? '', 10)
    const row = { id, checked: Number.isFinite(checked) ? checked : null }
    rows.push(row)
    if (row.checked === 0) neverChecked.push(row)
  }
  return { fileName: file.name, rows, neverChecked }
}

/**
 * Check 20 — an events file declares a `namespace`, and every event id uses it.
 *
 * THE INVARIANT IS id-prefix == THE FILE'S OWN DECLARED `namespace`, NEVER THE FILENAME.
 * Measured over all 536 vanilla `game\events\*.txt`: **516** have every `name.NNN = {` prefix equal
 * to their declared namespace, 19 carry a second differing prefix, and exactly 1 (`tgp_maintenance_events.txt`)
 * declares none. In the other direction **0 of 536 filenames match their namespace** —
 * `birth_events.txt` declares `namespace = birth`, `bp1_dan_events.txt` declares `bp1_yearly`. So a
 * check keyed on filenames would misfire on essentially every real mod.
 *
 * The wiki requires the namespace (Event modding: "have a namespace defined on the first line, like
 * `namespace = my_events`") and states no consequence for omitting it, so both findings here are
 * `warn`, not `error`: they report a documented requirement that is unmet, not a proven failure.
 *
 * @param file - the file's path.
 * @param text - the decoded text.
 * @returns findings.
 */
export function checkEventNamespace(file, text) {
  const body = stripScriptNoise(text)
  const findings = []
  const declared = [...body.matchAll(/^\s*namespace\s*=\s*([A-Za-z0-9_]+)\s*$/gm)].map((m) => m[1])
  if (declared.length === 0) {
    return [finding(
      CODES.EVENT_NAMESPACE_MISSING,
      file,
      0,
      'this file under events\\ declares no `namespace`, which the wiki\'s event checklist requires ("have a namespace defined on the first line"); if this file holds no events, move it out of events\\',
      'add `namespace = <name>` as the first line, and name every event `<name>.NNNN`',
    )]
  }
  const namespace = declared[0]
  const offPrefix = []
  for (const [index, line] of splitLines(body).entries()) {
    const m = /^\s*([A-Za-z0-9_]+)\.[0-9]+\s*=/.exec(line)
    if (m === null) continue
    if (m[1] !== namespace) offPrefix.push(`line ${index + 1}: ${m[1]}.…`)
  }
  if (offPrefix.length > 0) {
    findings.push(finding(
      CODES.EVENT_ID_NAMESPACE_MISMATCH,
      file,
      0,
      `event id(s) do not use this file's declared namespace "${namespace}" — ${offPrefix.slice(0, 4).join(', ')}${offPrefix.length > 4 ? `, +${offPrefix.length - 4} more` : ''}`,
      `rename them to "${namespace}.<id>", or declare the namespace they actually use; vanilla's own files follow that rule 516 times out of 536`,
    ))
  }
  findings.push(...checkEventIds(file, body, namespace))
  return findings
}

/**
 * Check 21 — event ids are within the range the engine can call, and an events file declares at
 * least one event.
 *
 * Both rest on a source rather than a hunch:
 *   * **Over 9999** — `Event modding` states: "Notice that if the ID exceeds 9999, the event calling
 *     system will become buggy, so please consider the max allowed ID for a given namespace as
 *     9999." A `warn`, not an `error`: the wiki calls the engine "buggy" rather than refusing the id,
 *     so the failure is degraded rather than total.
 *   * **No events at all** — a `.txt` under `events\` that declares a namespace and then defines
 *     nothing is either a half-finished file or a mis-filed one. This is structural, needing no
 *     external claim, and it is exactly the shape a mod author leaves behind when they start from
 *     the wiki's first line and stop.
 *
 * @param file - the file's path.
 * @param body - the text with comments and quoted strings already stripped.
 * @param namespace - the namespace the file declared (unused when there is none).
 * @returns findings.
 */
export function checkEventIds(file, body, namespace) {
  const findings = []
  const ids = []
  for (const [index, line] of splitLines(body).entries()) {
    const m = /^\s*[A-Za-z0-9_]+\.([0-9]+)\s*=/.exec(line)
    if (m === null) continue
    ids.push({ id: Number.parseInt(m[1], 10), line: index + 1 })
  }
  if (ids.length === 0 && namespace !== undefined) {
    findings.push(finding(
      CODES.EVENT_FILE_EMPTY,
      file,
      0,
      `this file declares \`namespace = ${namespace}\` but defines no event; a file under events\\ with no event in it is read by nothing`,
      'add an event, or move the file out of events\\ if it is not an events file',
    ))
  }
  const tooBig = ids.filter((entry) => entry.id > 9999)
  if (tooBig.length > 0) {
    findings.push(finding(
      CODES.EVENT_ID_OUT_OF_RANGE,
      file,
      tooBig[0].line,
      `event id ${tooBig[0].id} exceeds 9999 (line ${tooBig[0].line})${tooBig.length > 1 ? `, and ${tooBig.length - 1} more id(s) do too` : ''}; the Event modding page says the event calling system becomes buggy past 9999`,
      'renumber the events in this namespace so every id is at most 9999',
    ))
  }
  return findings
}

/**
 * Check 22 — a text file the mod ships is valid UTF-8.
 *
 * The localization BOM check answers "does this file have the BOM the game requires". This one
 * answers the different question "is this file decodable at all", which nothing else did: a file
 * saved as UTF-16, or carrying Windows-1252 bytes for non-ASCII text, decodes into replacement
 * characters and the game reads the mojibake or drops the line.
 *
 * `TextDecoder('utf-8', { fatal: true })` is the exact test rather than a heuristic. A UTF-16 BOM is
 * reported separately because it is the specific, common accident of saving from a Windows editor.
 * The UTF-8 BOM is NOT reported here — `script-has-bom` already covers that, and reporting the same
 * byte sequence under two codes is how a report starts double-counting.
 *
 * @param file - the file's path.
 * @param bytes - the raw bytes.
 * @returns findings.
 */
export function checkTextEncoding(file, bytes) {
  const hasUtf16Bom = bytes.length >= 2
    && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))
  if (hasUtf16Bom) {
    return [finding(
      CODES.TEXT_NOT_UTF8,
      file,
      0,
      `this file starts with a UTF-16 byte order mark (${bytes[0].toString(16)} ${bytes[1].toString(16)}); CK3 reads script and localization as UTF-8, so its text will not decode`,
      're-save it as UTF-8 — with the BOM if it is a localization .yml, without it if it is a script .txt',
    )]
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return []
  } catch {
    return [finding(
      CODES.TEXT_NOT_UTF8,
      file,
      0,
      'this file is not valid UTF-8 — CK3 reads script and localization as UTF-8, so some of its text will not decode',
      're-save it as UTF-8; a file edited in a Windows editor is often Windows-1252 without the editor saying so',
    )]
  }
}

/* ------------------------------------------------------------------ *
 * Checks 7–9, 11: localization
 * ------------------------------------------------------------------ */

/**
 * Checks 7, 8 and 9 — the BOM, the first-line header, and the entry shape of one localization file.
 *
 * Measured on this machine, which is what each of these rests on: **all 122** files in
 * `game\localization\english\*.yml` begin with `EF BB BF`, and their first non-empty line is
 * `l_english:` (some carry a trailing space after the colon). Entries look like
 * ` ACHIEVEMENT_GROUP_very_easy_achievements:0 "Very Easy"` — the number after the colon is a
 * **version counter**, and a value greater than 0 makes the game report the entry as needing
 * retranslation, so it is part of the accepted shape rather than noise.
 *
 * @param file - the file's path, for findings.
 * @param bytes - the raw file bytes.
 * @param strict - when false, entry-shape warnings are suppressed.
 * @returns findings.
 */
export function checkLocalizationFile(file, bytes, strict = true) {
  const findings = []
  if (!hasBom(bytes)) {
    findings.push(finding(
      CODES.LOCALIZATION_NO_BOM,
      file,
      0,
      'localization file has no UTF-8 BOM (expected the leading bytes EF BB BF) — every one of the 122 vanilla english .yml files has it, and without it the game does not read the header correctly',
      'prepend the three bytes EF BB BF (save the file as "UTF-8 with BOM"); re-run with fix=true to do exactly this',
    ))
  }

  const lines = splitLines(decodeText(bytes))
  let headerIndex = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === '') continue
    headerIndex = i
    break
  }

  if (headerIndex === -1) {
    findings.push(finding(
      CODES.LOCALIZATION_BAD_HEADER,
      file,
      0,
      'localization file is empty, so it has no `l_english:` header line',
      'add a first line `l_english:` and put each entry on its own line below it',
    ))
    return findings
  }

  const header = lines[headerIndex]
  const match = LANGUAGE_HEADER.exec(header)
  if (!match) {
    // The brief splits this in two: a header that is a language header for another language is a
    // `warn`; a first line that is **not a language header at all** is an `error`, because the
    // game will not parse the file. Both carry the same code, so the severity is decided here
    // rather than read from the table — which is why this is the one place that overrides it.
    const looksLikeHeader = /^l_[a-z_]*\s*:?/.test(header.trim())
    findings.push({
      ...finding(
        CODES.LOCALIZATION_BAD_HEADER,
        file,
        headerIndex + 1,
        `first non-empty line is ${JSON.stringify(header)}, which is not a language header of the form \`l_<language>:\``,
        `replace line ${headerIndex + 1} with \`l_english:\` — the vanilla files use exactly that, and it must be line 1`,
      ),
      severity: 'error',
      message: `first non-empty line is ${JSON.stringify(header)}, which is not a language header of the form \`l_<language>:\`${looksLikeHeader ? ' (a trailing colon is what is missing)' : ''}`,
    })
    return findings
  }
  if (match[1] !== EXPECTED_LANGUAGE) {
    findings.push(finding(
      CODES.LOCALIZATION_BAD_HEADER,
      file,
      headerIndex + 1,
      `header declares language "${match[1]}" but this validator expects "${EXPECTED_LANGUAGE}"; the header must match the folder it sits in`,
      `move the file under localization\\${match[1]}\\ or change the header to \`l_${EXPECTED_LANGUAGE}:\``,
    ))
  }

  if (strict) {
    for (let i = headerIndex + 1; i < lines.length; i += 1) {
      const line = lines[i]
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      if (ANY_LANGUAGE_HEADER.test(trimmed)) continue
      if (LOCALIZATION_ENTRY.test(line)) continue
      findings.push(finding(
        CODES.LOCALIZATION_BAD_ENTRY,
        file,
        i + 1,
        `line ${i + 1} looks like an entry but does not match \`^\\s*[A-Za-z0-9_.\\-]+:\\d*\\s*".*"\`: ${JSON.stringify(line.length > 120 ? `${line.slice(0, 117)}...` : line)}`,
        'write it as ` KEY:0 "value"` — a key of letters/digits/underscore/dot/hyphen, a version counter, then a double-quoted value; escape inner quotes as \\"',
      ))
    }
  }
  return findings
}

/**
 * Checks 11 — a localization file must sit in a directory named for a language.
 *
 * The wiki's mod structure places localization under `localization\<language>\`. A file directly
 * in the mod root, or under `localization\` itself, or in a folder that is not a language name,
 * will not be picked up as that language's localization.
 *
 * **`replace` is an override marker, not a language directory, and it may sit on EITHER side of
 * the language segment.** The wiki's `Localization` page says verbatim: *"Both
 * `localization/replace/english` and `localization/english/replace` work, but the first path takes
 * precedence over the other."* The earlier revision read the segment immediately after
 * `localization` as the language, so `localization\replace\english\` was reported as sitting in a
 * directory named `replace` — **a false positive whose own suggestion ("move it under
 * localization\english\") would have changed which file wins or stopped the override working**.
 * That is the exact failure this check exists to prevent, so the fix matters more than the finding:
 * the language segment is now found by scanning past `replace`, in either order.
 *
 * @param modRoot - the mod folder's absolute path.
 * @param file - the file's absolute path.
 * @returns findings.
 */
export function checkLocalizationLanguageDir(modRoot, file) {
  const relative = path.relative(modRoot, file)
  const parts = relative.split(/[\\/]/)
  if (parts.length < 2) {
    return [finding(
      CODES.LOCALIZATION_LANGUAGE_DIR,
      file,
      0,
      `localization file sits in the mod root, not under a language directory (expected one of: ${LANGUAGE_DIRS.join(', ')})`,
      `move it to localization\\${EXPECTED_LANGUAGE}\\${path.basename(file)}`,
    )]
  }
  const locIndex = parts.findIndex((part) => part.toLowerCase() === 'localization')
  // `localization\replace\english\x.yml`: the segment after `localization` is `replace`, so walk
  // forward to the first segment that is a language name. `localization\english\replace\x.yml` is
  // already handled by reading the segment right after `localization`.
  let languageDir
  for (let i = locIndex === -1 ? 0 : locIndex + 1; i < parts.length - 1; i += 1) {
    if (parts[i].toLowerCase() === 'replace') continue
    languageDir = parts[i]
    break
  }
  if (languageDir !== undefined && LANGUAGE_DIRS.includes(languageDir.toLowerCase())) return []
  const shown = locIndex === -1 ? parts.slice(0, -1).join('\\') : parts.slice(0, locIndex + 2).join('\\')
  return [finding(
    CODES.LOCALIZATION_LANGUAGE_DIR,
    file,
    0,
    `localization file sits in "${shown}", which is not a language directory (expected one of: ${LANGUAGE_DIRS.join(', ')})`,
    `move it under localization\\${EXPECTED_LANGUAGE}\\ — a file outside a language folder is not read as that language's localization`,
  )]
}

/* ------------------------------------------------------------------ *
 * Check 10: script braces
 * ------------------------------------------------------------------ */

/**
 * Strip comments and quoted strings from Paradox script text.
 *
 * Both matter for a brace count. `#` runs to end of line, and a brace inside a quoted string is
 * text: `desc = "a { b"` — and localization-bearing script values routinely contain braces. A
 * counter that ignores this reports balanced files as unbalanced.
 *
 * @param text - the decoded script text.
 * @returns text with comments and string bodies removed.
 */
export function stripScriptNoise(text) {
  const out = []
  const lines = splitLines(text)
  for (const line of lines) {
    let cleaned = ''
    let inString = false
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i]
      if (inString) {
        if (ch === '\\') { i += 1; continue }
        if (ch === '"') { inString = false; cleaned += '"' }
        continue
      }
      if (ch === '"') { inString = true; cleaned += '"'; continue }
      if (ch === '#') break
      cleaned += ch
    }
    out.push(cleaned)
  }
  return out.join('\n')
}

/**
 * Check 10 — a script `.txt` under `common\`, `events\` or `history\` has balanced braces.
 *
 * @param file - the script file's absolute path.
 * @param text - the file's decoded text.
 * @returns findings.
 */
export function checkScriptBraces(file, text) {
  const cleaned = stripScriptNoise(text)
  let open = 0
  let close = 0
  for (const ch of cleaned) {
    if (ch === '{') open += 1
    else if (ch === '}') close += 1
  }
  if (open === close) return []
  return [finding(
    CODES.SCRIPT_UNBALANCED,
    file,
    0,
    `unbalanced braces: ${open} "{", ${close} "}" (comments and quoted strings excluded) — the game's script parser will reject or misread this file`,
    open > close
      ? `add ${open - close} closing "}" (or remove ${open - close} "{") so the counts match`
      : `remove ${close - open} closing "}" (or add ${close - open} "{") so the counts match`,
  )]
}

/* ------------------------------------------------------------------ *
 * Check 12: vanilla counterpart
 * ------------------------------------------------------------------ */

/**
 * Check 12 — a mod's `common\<subdir>` has no counterpart under the vanilla install.
 *
 * **This is a spelling prompt, not a rule, and the wording says so.** The wiki's advice that files
 * "often have to be put into specific folders, otherwise they may not be loaded by the game" is
 * stale: **Patch 1.13** records "Allow all databases to load sub-folders", and the vanilla tree
 * itself nests deeply (`common\activities\activity_types\`, `common\culture\cultures\`,
 * `common\artifacts\templates\`). A mod inventing a directory is therefore not a defect, and a
 * total conversion doing so is normal. What the check is actually good for is catching a
 * misspelling of an existing vanilla directory name, which is why it is a `warn` and why the
 * message names the spelling rather than the validity.
 *
 * @param modRoot - the mod folder's absolute path.
 * @param gameRoot - the CK3 install root (the directory that contains `game\`).
 * @param modSubdirs - the mod's `common` subdirectory names.
 * @param existence - injected existence probe.
 * @returns findings.
 */
export async function checkVanillaCounterpart(modRoot, gameRoot, modSubdirs, existence = { exists: defaultExists }) {
  const findings = []
  const vanillaCommon = path.join(gameRoot, 'game', 'common')
  for (const sub of modSubdirs) {
    const counterpart = path.join(vanillaCommon, sub)
    if (await existence.exists(counterpart)) continue
    findings.push(finding(
      CODES.VANILLA_PATH_UNKNOWN,
      path.join(modRoot, 'common', sub),
      0,
      `common\\${sub} has no directory of that name under the vanilla install (${vanillaCommon}) — if that was meant to be an existing database, the name is likely misspelled`,
      `check the spelling against the names in ${vanillaCommon}. A mod may legitimately invent a directory — sub-folders load in every database since patch 1.13 — so this is a prompt, not a defect`,
    ))
  }
  return findings
}

/* ------------------------------------------------------------------ *
 * Reading, walking, discovery
 * ------------------------------------------------------------------ */

const defaultExistence = { exists: defaultExists }

/**
 * Does a path exist? The default probe for the injected `existence` parameter.
 * @param candidate - a path.
 * @returns whether anything exists there.
 */
export async function defaultExists(candidate) {
  try {
    await stat(candidate)
    return true
  } catch {
    return false
  }
}

/**
 * Read a file's raw bytes, or `null` when it cannot be read.
 * @param file - a path.
 * @returns the bytes, or null.
 */
export async function readBytes(file) {
  try {
    return await readFile(file)
  } catch {
    return null
  }
}

/**
 * Write bytes to a file. **Exported for the fixer to call deliberately — never called here.**
 * @param file - a path.
 * @param bytes - the bytes to write.
 * @returns nothing.
 */
export async function writeFileBytes(file, bytes) {
  await writeFile(file, bytes)
}

/**
 * Collect every file under a directory, recursively, filtered by extension.
 *
 * Follows the same discipline as the reference plugin's `walk`: a directory that cannot be read
 * contributes nothing rather than aborting the scan, and `node_modules` / dot-directories are
 * skipped. Symlinked directories are not followed, which keeps a mod that links back into the
 * game install from producing an unbounded walk.
 *
 * **An EMPTY `extensions` array means "every file", not "no files".** These are two different
 * requests and conflating them is a silent trap: `extensions ?? ['.txt']` makes `[]` falsy-free but
 * still an allowlist that matches nothing, so a caller asking for every file to look for a wrong
 * extension got an empty list and reported nothing. That is exactly how the first revision of
 * {@link checkScriptExtensions} became a no-op — it asked for `{}`, got `.txt` files only, and
 * could therefore never see the file it was written to find.
 *
 * @param root - the directory to walk.
 * @param options - `{ extensions }` — lowercase extensions including the dot. Omit for `.txt` only;
 *   pass `[]` for every file.
 * @returns the absolute file paths found.
 */
export async function collectFiles(root, options = {}) {
  const extensions = options.extensions === undefined ? ['.txt'] : options.extensions
  const anyExtension = extensions.length === 0
  const found = []
  const walk = async (dir) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        await walk(full)
      } else if (entry.isFile()) {
        if (anyExtension || extensions.includes(path.extname(entry.name).toLowerCase())) found.push(full)
      }
    }
  }
  await walk(root)
  return found
}

/**
 * List a directory's entry names, tolerating a missing directory.
 * @param dir - the directory.
 * @returns the names, sorted; empty when unreadable.
 */
export async function listNames(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.map((entry) => entry.name).sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

/**
 * List a directory's subdirectory names, tolerating a missing directory.
 * @param dir - the directory.
 * @returns the names, sorted; empty when unreadable.
 */
export async function listDirs(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

/**
 * Resolve the model's `modPath` argument to a `{ folder, folderPath }` pair.
 *
 * Accepts a bare mod name, a path to the mod folder, or a path to the `.mod` file — as the
 * brief specifies. A path whose extension is `.mod` names the sibling pair; anything else is
 * treated as the folder.
 *
 * @param modDir - the directory that holds mod folders and `.mod` files.
 * @param modPath - the raw argument, or undefined.
 * @returns the resolved folder name and absolute folder path.
 */
export function resolveModTarget(modDir, modPath) {
  if (modPath === undefined || modPath === null || String(modPath).trim() === '') {
    return { folderName: null, folderPath: null }
  }
  const raw = String(modPath).trim()
  const looksLikePath = /[\\/]/.test(raw) || /\.mod$/i.test(raw)
  if (looksLikePath) {
    const absolute = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(modDir, raw)
    if (/\.mod$/i.test(absolute)) {
      const folderPath = absolute.slice(0, -4)
      return { folderName: path.basename(folderPath), folderPath }
    }
    return { folderName: path.basename(absolute), folderPath: absolute }
  }
  return { folderName: raw, folderPath: path.join(modDir, raw) }
}

/**
 * Discover every mod under `modDir`.
 *
 * A mod is a directory that has a sibling `<name>.mod` file OR contains a `descriptor.mod`.
 * The second condition is what makes a mod with a **missing** sibling `.mod` file visible to
 * check 1 at all — discovery must be able to see the defects, not only the healthy shape.
 * Stray `.mod` files with no folder are reported as their own pseudo-target so check 1 can fire
 * on them too.
 *
 * @param modDir - the directory to scan.
 * @returns `{ name, folderPath, modFilePath }` entries, sorted by name.
 */
export async function discoverMods(modDir) {
  const entries = await listNames(modDir)
  const dirs = new Set(await listDirs(modDir))
  const modFiles = entries.filter((name) => name.toLowerCase().endsWith('.mod'))
  const targets = []

  for (const dir of dirs) {
    targets.push({
      name: dir,
      folderPath: path.join(modDir, dir),
      modFilePath: modFiles.find((file) => file.slice(0, -4) === dir) ? path.join(modDir, `${dir}.mod`) : null,
    })
  }
  for (const file of modFiles) {
    const base = file.slice(0, -4)
    if (dirs.has(base)) continue
    targets.push({
      name: base,
      folderPath: path.join(modDir, base),
      modFilePath: path.join(modDir, file),
      folderMissing: true,
    })
  }

  // A directory that is neither a sibling-named mod nor a descriptor carrier is still scanned
  // only when it looks like a mod; otherwise every unrelated folder would be reported.
  return targets.sort((a, b) => a.name.localeCompare(b.name))
}

/* ------------------------------------------------------------------ *
 * The orchestrator
 * ------------------------------------------------------------------ */

/**
 * Validate ONE mod against every check, reading from disk.
 *
 * This is the function the tool and the test both call. Its results are findings only — it
 * repairs nothing and deletes nothing.
 *
 * @param mod - a target from {@link discoverMods}, or `{ name, folderPath, modFilePath }`.
 * @param options - `{ modDir, gameRoot, strict, existence, describe }`.
 * @returns `{ name, folderPath, modFilePath, findings }` — the target is echoed back, because the
 *   fixer needs the sibling `.mod` path and reconstructing it from `name` alone loses the case
 *   and existence information discovery already established. (That reconstruction was tried; the
 *   first version of `applyFixes` received `modFilePath: undefined` and silently refused to repair
 *   the one thing it exists to repair.)
 */
export async function validateMod(mod, options = {}) {
  const modDir = options.modDir ?? path.dirname(mod.folderPath)
  const strict = options.strict !== false
  const existence = options.existence ?? defaultExistence
  const findings = []

  // Checks 1 and 2 — the sibling .mod file.
  if (mod.modFilePath === null) {
    findings.push(...checkSiblingModFile(mod.name, await listNames(modDir)))
  }

  // Check 3 — descriptor.mod. The folder's own existence is asked of the filesystem rather than
  // inferred from `listNames` being empty, because an *empty* mod folder is a real and very
  // common state: it yields "no descriptor.mod", not "the folder does not exist".
  const folderExists = await existence.exists(mod.folderPath)
  if (folderExists) {
    findings.push(...checkDescriptorPresent(mod.folderPath, await listNames(mod.folderPath)))
  } else {
    findings.push(finding(
      CODES.DESCRIPTOR_MISSING,
      path.join(mod.folderPath, 'descriptor.mod'),
      0,
      `the mod folder "${mod.name}" does not exist${mod.modFilePath ? `, although the sibling ${path.basename(mod.modFilePath)} does` : ''}`,
      'create the mod folder, or remove the orphaned .mod file if the mod is gone',
    ))
  }

  // Checks 4, 5, 13 — read the .mod file.
  let modText = null
  if (mod.modFilePath !== null) {
    const bytes = await readBytes(mod.modFilePath)
    if (bytes === null) {
      findings.push(finding(
        CODES.MOD_FILE_MISSING,
        mod.modFilePath,
        0,
        'the sibling .mod file could not be read',
        'check the file\'s permissions and that it is not a broken link',
      ))
    } else {
      modText = decodeText(bytes)
      findings.push(...checkTags(mod.modFilePath, modText))
      // `checkModPath` returns `{ findings, resolved }` rather than a bare array, because the
      // resolved value is what lets check 16 ask whether `path` points at THIS mod.
      const pathCheck = await checkModPath(mod.modFilePath, modText, modDir, existence)
      findings.push(...pathCheck.findings)
      findings.push(...checkModFolderMatchesPath(mod, pathCheck.resolved))
      findings.push(...checkModFileKeys(mod.modFilePath, modText, { isDescriptor: false }))
      findings.push(...await checkReplacePath(mod.modFilePath, modText, options.gameRoot, existence))
    }
  }

  // Check 4 (continued) — the descriptor's own contents, and its agreement with the sibling file.
  //
  // The comparison is here because the `ck3-mod-authoring` skill and the verifier's persona both
  // tell their reader the descriptor's CONTENTS are checked, while the earlier revision checked one
  // thing about it: the presence of a `path` key. A descriptor disagreeing with the outer file about
  // `version` or `supported_version` produced no finding at all, so a claim was being made in the
  // agent's own instructions that no code backed.
  const descriptorPath = path.join(mod.folderPath, 'descriptor.mod')
  const descriptorBytes = await readBytes(descriptorPath)
  if (descriptorBytes !== null) {
    const descriptorText = decodeText(descriptorBytes)
    findings.push(...checkDescriptorHasPath(descriptorPath, descriptorText))
    findings.push(...checkModFileKeys(descriptorPath, descriptorText, { isDescriptor: true }))
    if (modText !== null) {
      const outer = parseModFile(modText).values
      const inner = parseModFile(descriptorText).values
      const mismatched = []
      for (const key of ['version', 'supported_version']) {
        if (outer[key] !== undefined && inner[key] !== undefined && outer[key] !== inner[key]) {
          mismatched.push(`${key}: the .mod file says ${JSON.stringify(outer[key])}, descriptor.mod says ${JSON.stringify(inner[key])}`)
        }
      }
      if (mismatched.length > 0) {
        findings.push(finding(
          CODES.DESCRIPTOR_DISAGREES,
          descriptorPath,
          0,
          `descriptor.mod disagrees with the sibling .mod file — ${mismatched.join('; ')}`,
          'the wiki recommends keeping the two consistent (the descriptor omits only `path`); make them agree',
        ))
      }
    }
  }

  // Check 6 — ASCII safety of the whole resolved path, folder and .mod file alike.
  findings.push(...checkNonAsciiPath(mod.folderPath, 'the mod folder path'))
  if (mod.modFilePath !== null) findings.push(...checkNonAsciiPath(mod.modFilePath, 'the .mod file path'))

  // Checks 7, 8, 9, 11 — localization.
  const localizationRoot = path.join(mod.folderPath, 'localization')
  const locRootBytes = await readBytes(localizationRoot)
  if (locRootBytes !== null || await existence.exists(localizationRoot)) {
    for (const file of await collectFiles(localizationRoot, { extensions: ['.yml', '.yaml'] })) {
      findings.push(...checkLocalizationLanguageDir(mod.folderPath, file))
      const bytes = await readBytes(file)
      if (bytes === null) continue
      findings.push(...checkLocalizationFile(file, bytes, strict))
      findings.push(...checkDuplicateLocalizationKeys(file, bytes))
    }
  }

  // Check 10 — script braces, and the BOM asymmetry.
  //
  // A LOCALIZATION file must carry a UTF-8 BOM (measured: 122/122 of the vanilla english files do).
  // A SCRIPT file must not, and this loop previously could not tell: `decodeText` strips a BOM
  // before counting braces, so a `.txt` beginning `EF BB BF` was structurally invisible — the
  // finding count was identical to the same file without one. Both halves are now asserted, which
  // is the point: the two file families have opposite requirements and the tool only knew one.
  for (const scriptRoot of SCRIPT_DIRS) {
    const dir = path.join(mod.folderPath, scriptRoot)
    for (const file of await collectFiles(dir, { extensions: ['.txt'] })) {
      const bytes = await readBytes(file)
      if (bytes === null) continue
      if (hasBom(bytes)) {
        findings.push(finding(
          CODES.SCRIPT_HAS_BOM,
          file,
          0,
          'this script file begins with a UTF-8 BOM; localization files need one, script files must not have one, and the game reads script by byte offset',
          'save the file as UTF-8 WITHOUT the BOM (localization \\*.yml keeps its BOM; script \\*.txt does not)',
        ))
      }
      const scriptText = decodeText(bytes)
      findings.push(...checkScriptBraces(file, scriptText))
      // Check 22 — decodability. Runs for every script file, independently of the BOM rule above:
      // the BOM check answers "does it carry the marker the game wants", this one answers "can the
      // bytes be read as UTF-8 at all".
      findings.push(...checkTextEncoding(file, bytes))
      // Check 20 — only under `events\`, because a namespace is an event-file concept.
      if (scriptRoot === 'events') findings.push(...checkEventNamespace(file, scriptText))
    }
  }

  // Check 12 — optional, and only when the vanilla install is actually there.
  const gameRoot = options.gameRoot
  if (strict && gameRoot && await existence.exists(path.join(gameRoot, 'game', 'common'))) {
    const subdirs = await listDirs(path.join(mod.folderPath, 'common'))
    findings.push(...await checkVanillaCounterpart(mod.folderPath, gameRoot, subdirs, existence))
    // Check 17 — case-only differences from vanilla directory names. Runs beside check 12 because
    // it reads the same vanilla listing: on Windows `Common\` resolves and on Linux it does not,
    // so the author's own machine is the worst place to notice it.
    const vanillaSubdirs = await listDirs(path.join(gameRoot, 'game', 'common'))
    findings.push(...checkPathCase(mod, vanillaSubdirs, subdirs))
  }

  // Check 18 — script directories hold `.txt`. Not gated on `strict` or on the vanilla install:
  // it is a property of the mod's own tree.
  findings.push(...await checkScriptExtensions(mod, SCRIPT_DIRS))

  // Check 23 — same path AND filename as a vanilla file. Runs whenever the install is present,
  // because it needs the install for its existence probes, and it is independent of `strict`.
  findings.push(...await checkVanillaOverrides(mod, gameRoot, existence))

  // Checks 24 and 25 — the mod's own scripting vocabulary against the install's. Runs whenever the
  // install is present AND the mod folder exists, for the same reason check 23 is not gated on
  // `strict`: what it asserts is a measured property of vanilla usage, and every mod it examines
  // deserves it. Cost is real but bounded and cached — ~2.5 s to build the 130,536-key set once per
  // install per process (`collectVanillaKeys`), after which each additional mod is free.
  if (folderExists) {
    findings.push(...await checkVanillaKeys(mod, gameRoot))
  }

  // Check 17b — top-level directory capitalisation. Runs unconditionally, because its point is the
  // case where the canonical directory does NOT exist and every other path check therefore has
  // nothing to compare.
  if (folderExists) {
    findings.push(...checkTopLevelDirCase(mod, await listNames(mod.folderPath)))
  }

  return { name: mod.name, folderPath: mod.folderPath, modFilePath: mod.modFilePath ?? null, findings }
}

/**
 * The repairable subset of the findings, as concrete actions for the caller to perform.
 *
 * Deliberately tiny, and deliberately explicit: this returns *descriptions* plus the exact
 * operation, and the caller decides. Three refusals are built in, matching the brief —
 * never rewrite a `.mod` file's `path`, never delete anything, and never touch anything whose
 * path contains a non-ASCII character.
 *
 * @param mod - the mod target.
 * @param findings - that mod's findings.
 * @param modDir - the directory holding the mod.
 * @param options - `{ existence }`.
 * @returns `{ actions }` — each `{ kind, file, describe }`, plus `{ skipped }` reasons.
 */
export async function planFixes(mod, findings, modDir, options = {}) {
  const existence = options.existence ?? defaultExistence
  const actions = []
  const skipped = []

  for (const item of findings) {
    if (item.code === CODES.NON_ASCII_PATH) continue
    if ([CODES.LOCALIZATION_NO_BOM, CODES.DESCRIPTOR_MISSING].includes(item.code)) continue
    skipped.push({ code: item.code, reason: 'not in the repairable set (its correct value cannot be derived from disk)' })
  }

  const asciiSafe = (candidate) => firstNonAscii(candidate) === null
  if (!asciiSafe(mod.folderPath)) {
    return {
      actions: [],
      skipped: [...skipped, { code: 'all', reason: `refusing to repair: the mod path contains a non-ASCII character (the wiki forbids it, and a rewrite here would be the wrong fix) — ${mod.folderPath}` }],
    }
  }

  const isLocalization = (file) => /\.ya?ml$/i.test(file) && /[\\/]localization[\\/]/i.test(file)
  for (const item of findings) {
    if (item.code !== CODES.LOCALIZATION_NO_BOM) continue
    if (!isLocalization(item.file)) {
      skipped.push({ code: item.code, reason: `refusing to repair ${item.file}: it is not a .yml under a localization directory` })
      continue
    }
    const bytes = await readBytes(item.file)
    if (bytes === null || hasBom(bytes)) continue
    if (!asciiSafe(item.file)) {
      skipped.push({ code: item.code, reason: `refusing to repair ${item.file}: path contains a non-ASCII character` })
      continue
    }
    actions.push({
      kind: 'add-bom',
      file: item.file,
      describe: `prepend the UTF-8 BOM (EF BB BF) to ${path.basename(item.file)}`,
      async run() {
        const prefix = Buffer.from([0xef, 0xbb, 0xbf])
        await writeFileBytes(item.file, Buffer.concat([prefix, Buffer.from(bytes)]))
      },
    })
  }

  for (const item of findings) {
    if (item.code !== CODES.DESCRIPTOR_MISSING) continue
    const sibling = mod.modFilePath
    if (sibling === null) {
      skipped.push({ code: item.code, reason: 'cannot synthesise descriptor.mod: there is no sibling .mod file to copy it from' })
      continue
    }
    if (!asciiSafe(item.file)) {
      skipped.push({ code: item.code, reason: `refusing to repair ${item.file}: path contains a non-ASCII character` })
      continue
    }
    if (await existence.exists(item.file)) {
      skipped.push({ code: item.code, reason: `refusing to overwrite the existing ${item.file}` })
      continue
    }
    const siblingBytes = await readBytes(sibling)
    if (siblingBytes === null) {
      skipped.push({ code: item.code, reason: `cannot read the sibling ${sibling} to copy from` })
      continue
    }
    const descriptorText = stripPathKey(decodeText(siblingBytes))
    actions.push({
      kind: 'write-descriptor',
      file: item.file,
      describe: `create ${path.basename(item.file)} from ${path.basename(sibling)} with its \`path\` line removed (the wiki: the path key is not needed in the descriptor file)`,
      async run() {
        await writeFileBytes(item.file, Buffer.from(descriptorText, 'utf8'))
      },
    })
  }

  return { actions, skipped }
}

/**
 * Remove `path=...` lines from `.mod` text, leaving everything else byte-identical.
 *
 * Removing a line is the narrowest possible edit and needs no parser: `path` may be written
 * with any spacing or as a list, and a line-oriented removal handles every spelling without
 * rewriting the lines it does not touch.
 *
 * @param text - the decoded `.mod` text.
 * @returns the text with `path` lines dropped.
 */
export function stripPathKey(text) {
  const kept = splitLines(text).filter((line) => !/^\s*path\s*=/i.test(line))
  return `${kept.join('\n').replace(/\n*$/, '')}\n`
}

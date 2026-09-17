/**
 * dsh-ck3-modcheck — offline falsification test.
 *
 *     node test/falsify.mjs      # exit 0 on pass, exit 1 on any failure
 *
 * ## What this file is for
 *
 * A validator that always complains is useless, and a validator that never complains is
 * useless in the opposite direction. So this test drives **both** directions:
 *
 * 1. A synthetic **clean** mod must produce **exactly zero** findings, with every check enabled
 *    — including the vanilla-counterpart check, against a synthetic `gameRoot`. This is the half
 *    that catches a check which fires on healthy input.
 * 2. One planted defect per fixture must be reported, with the **exact code** the brief names.
 *    Each planted fixture is the clean mod plus one defect, so a passing assertion cannot be an
 *    accident of a different fixture's shape.
 * 3. The pure rule layer must run with **no Cordis context at all** — this file imports
 *    `lib/rules.mjs` and `lib/index.js` directly and never constructs a `ctx`.
 * 4. **The generated skeleton must be FUNCTIONALLY correct, not merely structurally valid.**
 *    This clause was added after exactly that gap let six real defects ship while this suite
 *    passed 107/107. Every assertion in clause 1 and 2 was satisfied by a skeleton that could not
 *    show a player anything: a decision whose icon pointed at a file that did not exist, an
 *    undefined event theme, a CK2-only property, no call site for the generated event, and two
 *    referenced localization keys that were never emitted. **Passing a validator and working are
 *    different properties**, and a scaffold's own output needs the second kind of assertion —
 *    which is what the `scaffoldMod:` block now asserts, against invariants rather than a golden
 *    file, and each with a known-bad value it must reject.
 *
 * ## Nothing here touches a real mod, a real mod directory, or the game
 *
 * Every fixture is written under `os.tmpdir()`. `D:\CK3Mods` (the configured `modDir`) is never
 * written to and need not exist — that is why the cleanliness assertion passes an explicit
 * synthetic `gameRoot` and an explicit `modDir`. The one real filesystem read is the read-only
 * vanilla probe, which is why it is guarded by an existence check.
 *
 * ## Config assertions here are not redundant with `bin/preflight.mjs`
 *
 * That script reads a plugin's exported `Config` only when the export is a **function**
 * (`bin/preflight.mjs:178`, `typeof Schema !== 'function'` → `no-schema`) and prints
 * `skip … (exports no usable Config schema)` for a plain-object Standard Schema like this one.
 * So for this plugin nothing else in the repo validates the config, and the assertions below are
 * the only coverage it has.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { Config, DEFAULTS, TOOLS_META, applyFixes, closingCaveat, renderReport, sortFindings } from '../lib/index.js'
import {
  CODES,
  SEVERITY,
  checkDuplicateLocalizationKeys,
  checkEventIds,
  checkEventNamespace,
  checkLocalizationFile,
  checkLocalizationLanguageDir,
  checkModFileKeys,
  checkModFolderMatchesPath,
  checkModPath,
  checkPathCase,
  checkReplacePath,
  checkScriptBraces,
  checkScriptExtensions,
  checkSiblingModFile,
  checkTags,
  checkTextEncoding,
  checkVanillaKeys,
  checkVanillaOverrides,
  clearVanillaKeyCache,
  collectFiles,
  compareLauncherToDisk,
  compareLauncherToDiskFiles,
  describeLogRun,
  listLauncherModFiles,
  readLauncherState,
  scaffoldMod,
  decodeText,
  discoverMods,
  firstNonAscii,
  hasBom,
  parseEventLog,
  parseLogLine,
  planFixes,
  probeLauncherDatabases,
  readDeclaredThemes,
  readRuntimeEvidence,
  selectLauncherCandidate,
  splitLines,
  validateMod,
} from '../lib/rules.mjs'

const VANILLA_ROOT = 'D:\\Program Files (x86)\\Steam\\steamapps\\common\\Crusader Kings III'

/**
 * Pick a fixture root whose **whole** path is ASCII.
 *
 * This is not ceremony — it is the first thing this test caught about itself. `os.tmpdir()` on
 * this machine answers `C:\Users\曦曦\AppData\Local\Temp`, and the user name is `曦曦`, so the
 * first version of this file built every fixture under a non-ASCII path and the clean fixture
 * reported `non-ascii-path` twice. That is the validator being right about a bad fixture. A
 * clean fixture must therefore be built somewhere ASCII-safe, which is also exactly what the
 * wiki sentence demands of a real mod.
 *
 * @returns an existing absolute directory path containing no character above code 127.
 */
async function pickAsciiRoot() {
  const candidates = [
    `D:\\dsh-ck3-modcheck-falsify-${process.pid}`,
    `C:\\Windows\\Temp\\dsh-ck3-modcheck-falsify-${process.pid}`,
    path.join(os.tmpdir(), `dsh-ck3-modcheck-${process.pid}`),
  ]
  for (const candidate of candidates) {
    if (firstNonAscii(candidate) !== null) continue
    try {
      await mkdir(candidate, { recursive: true })
      const info = await stat(candidate)
      if (info.isDirectory()) return candidate
    } catch {
      // try the next candidate
    }
  }
  throw new Error('no ASCII-safe writable directory found for the fixtures')
}

/** Collected assertions, so one failure does not hide the rest. */
const results = []
let failures = 0

/**
 * Record one assertion.
 * @param label - what was asserted.
 * @param ok - whether it held.
 * @param detail - evidence, printed either way.
 */
function check(label, ok, detail = '') {
  results.push({ label, ok, detail })
  if (!ok) failures += 1
}

/**
 * Assert a fixture's findings contain exactly one finding of the expected code, and no others.
 *
 * @param label - the assertion label.
 * @param findings - the findings the rule layer produced.
 * @param expectedCode - the code that must be present.
 * @param alsoExpected - other codes this fixture legitimately produces, so the assertion stays
 *   strict about the set rather than being relaxed to "contains". Every entry here should be
 *   justified in the call site's comment; an unexplained one is how a check silently stops firing.
 */
function checkSingle(label, findings, expectedCode, alsoExpected = []) {
  const codes = findings.map((f) => f.code).sort()
  const want = [expectedCode, ...alsoExpected].sort()
  const ok = codes.length === want.length && codes.every((code, i) => code === want[i])
  check(label, ok, `expected exactly [${want.join(', ')}], got [${codes.join(', ')}]`)
}

/* ------------------------------------------------------------------ *
 * Fixture construction
 * ------------------------------------------------------------------ */

const BOM = Buffer.from([0xef, 0xbb, 0xbf])

/**
 * Write a file, creating parent directories.
 * @param file - the path.
 * @param content - a string, or bytes.
 * @returns the path.
 */
async function put(file, content) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, typeof content === 'string' ? Buffer.from(content, 'utf8') : content)
  return file
}

/**
 * A `.mod` file body whose `path` resolves to the mod's own folder.
 *
 * The value is written relative to `modDir` — which is the *shape* the fixtures use, not a claim
 * that the launcher reads it that way. The format is unverified (see README), so the rules only
 * ever assert that the target exists.
 *
 * @param name - the mod name.
 * @param tags - the tag list.
 * @returns the file body.
 */
function modFileBody(name, tags = ['Gameplay', 'Utilities']) {
  const list = tags.map((tag) => `\t\t"${tag}"`).join('\n')
  return `version="0.1.0"\n`
    + `tags={\n${list}\n}\n`
    + `name="${name}"\n`
    + `supported_version="1.16.*"\n`
    + `path="${name}"\n`
}
/** A `descriptor.mod` body — the same file minus the `path` line, as the wiki recommends. */
function descriptorBody(name, tags = ['Gameplay', 'Utilities']) {
  const list = tags.map((tag) => `\t\t"${tag}"`).join('\n')
  return `version="0.1.0"\n`
    + `tags={\n${list}\n}\n`
    + `name="${name}"\n`
    + `supported_version="1.16.*"\n`
}

/**
 * Build the clean synthetic mod: a name-matching `.mod` + folder pair, a `descriptor.mod`
 * without a `path`, a BOM'd `l_english:` localization file under a language directory, and
 * balanced script under `common\` and `events\`.
 *
 * @param modDir - the directory to build it in.
 * @param options - `{ name, tags, locBytes, scriptBody }` overrides for the planted fixtures.
 * @returns the mod's name and folder path.
 */
async function buildCleanMod(modDir, options = {}) {
  const name = options.name ?? 'cleanmod'
  const folder = path.join(modDir, name)
  await mkdir(folder, { recursive: true })

  await put(path.join(modDir, `${name}.mod`), modFileBody(name, options.tags))
  await put(path.join(folder, 'descriptor.mod'), descriptorBody(name, options.tags))
  await put(
    path.join(folder, 'localization', 'english', `${name}_l_english.yml`),
    options.locBytes ?? Buffer.concat([BOM, Buffer.from('l_english: \n key_one:0 "One"\n key_two:1 "Two"\n', 'utf8')]),
  )
  await put(
    path.join(folder, 'common', 'scripted_effects', `${name}_effects.txt`),
    options.scriptBody ?? 'clean_effect = {\n\tadd_gold = 100\n\tif = { limit = { always = yes } add_prestige = 5 }\n}\n',
  )
  await put(
    path.join(folder, 'events', `${name}_events.txt`),
    'namespace = clean\nclean.1 = {\n\ttype = character_event\n\ttitle = "clean.1.t"\n\tdesc = "a quoted { brace } must not count"\n}\n',
  )
  return { name, folder }
}

/**
 * Copy the clean mod under a new name, so a planted fixture differs from the clean one by the
 * planted defect alone rather than by its whole shape.
 * @param from - the clean mod's `{ name, folder }`.
 * @param modDir - the destination directory.
 * @param name - the new mod name.
 * @returns the new `{ name, folder }`.
 */
async function cloneMod(from, modDir, name) {
  const folder = path.join(modDir, name)
  await mkdir(folder, { recursive: true })
  await put(path.join(modDir, `${name}.mod`), modFileBody(name))
  await put(path.join(folder, 'descriptor.mod'), descriptorBody(name))
  await put(
    path.join(folder, 'localization', 'english', `${name}_l_english.yml`),
    Buffer.concat([BOM, Buffer.from('l_english:\n key_one:0 "One"\n', 'utf8')]),
  )
  await put(
    path.join(folder, 'common', 'scripted_effects', `${name}_effects.txt`),
    'clean_effect = {\n\tadd_gold = 100\n}\n',
  )
  return { name, folder }
}

/* ------------------------------------------------------------------ *
 * Synthetic-vanilla vocabulary
 * ------------------------------------------------------------------ */

/**
 * The synthetic vanilla tree's file holding every property name the fixtures legitimately use.
 *
 * The scripting-vocabulary check (`vanilla-key-unknown`) compares a mod's depth-1 properties
 * against what the install actually uses, so a synthetic install that does not contain the
 * fixtures' own normal properties would report all of them. Seeding this file is what makes the
 * check's negative control meaningful: after it, the ONLY unknown names are planted ones.
 */
const SYNTHETIC_KEYS_FILE = () => path.join(syntheticGameRoot, 'game', 'common', 'vanilla_sample.txt')

/**
 * Property names the synthetic vanilla already declares.
 * @returns a `Set` of names.
 */
async function syntheticVocabulary() {
  const file = SYNTHETIC_KEYS_FILE()
  const known = new Set()
  try {
    for (const raw of splitLines(await readFile(file, 'utf8'))) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_.]*)\s*=/.exec(raw)
      if (m) known.add(m[1])
    }
  } catch { /* not seeded yet */ }
  return known
}

/**
 * Add the depth-1 property names of the given mod folders to the synthetic vanilla.
 *
 * Incremental on purpose: `validateMod` caches the vanilla key set per install on first read, so the
 * seed must be complete and correct *before* that read. Each caller seeds the fixtures it is about
 * to validate, and any block that adds keys afterwards calls `clearVanillaKeyCache()`.
 *
 * @param folders - mod folders whose properties must count as known.
 */
async function seedSyntheticVocabulary(folders) {
  const known = await syntheticVocabulary()
  for (const folder of folders) {
    for (const abs of await collectFiles(folder, { extensions: ['.txt'] })) {
      for (const raw of splitLines(await readFile(abs, 'utf8'))) {
        if (!raw.includes('=')) continue
        const m = /^\s*([A-Za-z_][A-Za-z0-9_.]*)\s*=/.exec(raw)
        if (m) known.add(m[1])
      }
    }
  }
  await put(SYNTHETIC_KEYS_FILE(), `${[...known].sort().join(' = { }\n')} = { }\n`)
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

const root = await pickAsciiRoot()

/** Synthetic vanilla tree: only the two `common` directories the fixtures reference. */
const syntheticGameRoot = path.join(root, 'synthetic-vanilla')
/**
 * A second mod directory whose own path contains a non-ASCII character — the defect the wiki
 * sentence is about, planted deliberately so `non-ascii-path` is falsified rather than assumed.
 */
const cjkModDir = path.join(root, '临时库')
/** Where the clean and planted-defect fixtures live. */
const modDir = path.join(root, 'mods')

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(path.join(syntheticGameRoot, 'game', 'common', 'scripted_effects'), { recursive: true })
  await mkdir(path.join(syntheticGameRoot, 'game', 'common', 'on_action'), { recursive: true })
  // Created so the `replace-path-destructive` assertion has a real vanilla directory to replace:
  // that check fires only when the named path EXISTS, which is the whole distinction between it and
  // `replace-path-unknown`. Without this the fixture would silently assert the wrong branch.
  await mkdir(path.join(syntheticGameRoot, 'game', 'history', 'characters'), { recursive: true })
  // `common\decisions` exists in the real install, so the fixture needs it too: `scaffoldMod`
  // generates a decisions sample, and a synthetic root missing the directory would report
  // `vanilla-path-unknown` for generated output that is actually correct.
  await mkdir(path.join(syntheticGameRoot, 'game', 'common', 'decisions'), { recursive: true })
  await mkdir(modDir, { recursive: true })

  const clean = await buildCleanMod(modDir)
  // Must happen before the first `validateMod` — that call builds and caches the vanilla key set.
  await seedSyntheticVocabulary([clean.folder])

  /* ---------------- 1. the clean mod must produce ZERO findings ---------------- */

  const cleanTarget = {
    name: clean.name,
    folderPath: clean.folder,
    modFilePath: path.join(modDir, `${clean.name}.mod`),
  }
  const cleanResult = await validateMod(cleanTarget, {
    modDir,
    gameRoot: syntheticGameRoot,
    strict: true,
  })
  check(
    'clean fixture: zero findings with every check enabled (strict=true, vanilla check on)',
    cleanResult.findings.length === 0,
    `findings: ${cleanResult.findings.map((f) => `${f.severity} ${f.code}`).join(', ') || '(none)'}`,
  )
  check(
    'clean fixture: a rendered report says so and still prints the caveat',
    renderReport({ title: 'clean', modsScanned: 1, baseDir: modDir, findings: cleanResult.findings }).includes('No findings')
      && renderReport({ title: 'clean', modsScanned: 1, baseDir: modDir, findings: cleanResult.findings }).includes('NOT VERIFIED'),
    'report contains "No findings" and "NOT VERIFIED"',
  )
  check(
    'validateMod echoes the target back, so the fixer has the sibling .mod path',
    cleanResult.modFilePath === path.join(modDir, `${clean.name}.mod`) && cleanResult.folderPath === clean.folder,
    `modFilePath: ${cleanResult.modFilePath}`,
  )

  /* ---------------- 2. six planted defects, one fixture each ---------------- */

  // Defect 1 — missing descriptor.mod (error).
  {
    const m = await cloneMod(clean, modDir, 'no_descriptor')
    await rm(path.join(m.folder, 'descriptor.mod'), { force: true })
    const { findings } = await validateMod({ name: m.name, folderPath: m.folder, modFilePath: path.join(modDir, `${m.name}.mod`) }, { modDir, gameRoot: syntheticGameRoot })
    checkSingle('defect 1: missing descriptor.mod → descriptor-missing (error)', findings, CODES.DESCRIPTOR_MISSING)
    check('defect 1 severity is error', findings[0]?.severity === 'error', `severity: ${findings[0]?.severity}`)
  }

  // Defect 2 — missing sibling .mod file (error).
  {
    const m = await cloneMod(clean, modDir, 'no_sibling')
    await rm(path.join(modDir, `${m.name}.mod`), { force: true })
    const { findings } = await validateMod({ name: m.name, folderPath: m.folder, modFilePath: null }, { modDir, gameRoot: syntheticGameRoot })
    // A folder with no sibling is discovered as a folder-only target; the one finding must be
    // `mod-file-missing`. `path-absent` cannot appear because there is no .mod file to read.
    checkSingle('defect 2: missing sibling .mod file → mod-file-missing (error)', findings, CODES.MOD_FILE_MISSING)
  }

  // Defect 3 — localization .yml without the UTF-8 BOM (error).
  {
    const m = await cloneMod(clean, modDir, 'no_bom')
    const loc = path.join(m.folder, 'localization', 'english', `${m.name}_l_english.yml`)
    await put(loc, Buffer.from('l_english:\n key_one:0 "One"\n', 'utf8')) // deliberately no BOM
    const { findings } = await validateMod({ name: m.name, folderPath: m.folder, modFilePath: path.join(modDir, `${m.name}.mod`) }, { modDir, gameRoot: syntheticGameRoot })
    checkSingle('defect 3: localization .yml with no UTF-8 BOM → localization-no-bom (error)', findings, CODES.LOCALIZATION_NO_BOM)
  }

  // Defect 4 — first line is not `l_english:` (error).
  {
    const m = await cloneMod(clean, modDir, 'bad_header')
    const loc = path.join(m.folder, 'localization', 'english', `${m.name}_l_english.yml`)
    await put(loc, Buffer.concat([BOM, Buffer.from('l_english\n key_one:0 "One"\n', 'utf8')]))
    const { findings } = await validateMod({ name: m.name, folderPath: m.folder, modFilePath: path.join(modDir, `${m.name}.mod`) }, { modDir, gameRoot: syntheticGameRoot })
    checkSingle('defect 4: first line is not `l_english:` → localization-bad-header', findings, CODES.LOCALIZATION_BAD_HEADER)
    check(
      'defect 4: a header that is not a language header at all is an error (a non-english language header is only a warn)',
      findings[0]?.severity === 'error',
      `severity: ${findings[0]?.severity}`,
    )
  }

  // Defect 5 — the .mod file's path points at a directory that does not exist (error).
  //
  // The body keeps `supported_version` so this fixture isolates ONE defect. Dropping it would add
  // `supported-version-missing` — which is its own test's job — and `path="mod/…"` under the
  // modDir also makes the target a different folder, so `mod-folder-mismatch` is expected here too:
  // the mod's own folder is `bad_path\`, and `mod/definitely_not_here` is not it.
  {
    const m = await cloneMod(clean, modDir, 'bad_path')
    await put(
      path.join(modDir, `${m.name}.mod`),
      `version="0.1.0"\ntags={\n\t\t"Gameplay"\n}\nname="${m.name}"\nsupported_version="1.16.*"\npath="mod/definitely_not_here"\n`,
    )
    const { findings } = await validateMod({ name: m.name, folderPath: m.folder, modFilePath: path.join(modDir, `${m.name}.mod`) }, { modDir, gameRoot: syntheticGameRoot })
    checkSingle('defect 5: .mod path points at a nonexistent directory → path-missing (error)', findings, CODES.PATH_MISSING, [CODES.MOD_FOLDER_MISMATCH])
  }

  // Defect 6 — a script .txt with unbalanced braces (error).
  {
    const m = await cloneMod(clean, modDir, 'unbalanced')
    // 3 x "{" against 2 x "}" once the comment and the quoted brace are excluded.
    await put(
      path.join(m.folder, 'common', 'scripted_effects', `${m.name}_effects.txt`),
      'clean_effect = {\n\tadd_gold = 100\n\tif = { limit = { always = yes }\n}\n',
    )
    const { findings } = await validateMod({ name: m.name, folderPath: m.folder, modFilePath: path.join(modDir, `${m.name}.mod`) }, { modDir, gameRoot: syntheticGameRoot })
    checkSingle('defect 6: script .txt with unbalanced braces → script-unbalanced (error)', findings, CODES.SCRIPT_UNBALANCED)
    check('defect 6 message reports both counts', /3 "\{", 2 "\}"/.test(findings[0]?.message ?? ''), `message: ${findings[0]?.message}`)
  }

  /* -------- 3. the remaining checks, so every code in CODES is falsified -------- */

  // mod-name-mismatch — a .mod file that differs from the folder by more than the extension.
  // Driven through `checkSiblingModFile` with an explicit entry list rather than through a real
  // directory, because that is the unit under test. Three branches are asserted, because the
  // first version of this check claimed a mismatch for **every unrelated .mod file** in the
  // directory — a false positive that a single-fixture test would have passed straight through.
  {
    const unrelated = checkSiblingModFile('modname', ['modname', 'other.mod'])
    checkSingle(
      'mod-file-missing: an unrelated .mod file in modDir must NOT be claimed as a name mismatch',
      unrelated,
      CODES.MOD_FILE_MISSING,
    )
    const caseVariant = checkSiblingModFile('actualfolder', ['actualfolder', 'ActualFolder.mod'])
    check(
      'mod-name-mismatch: a case-only variant beside the folder is reported as a mismatch',
      caseVariant.some((f) => f.code === CODES.MOD_NAME_MISMATCH)
        && caseVariant.some((f) => f.code === CODES.MOD_FILE_MISSING),
      `codes: [${caseVariant.map((f) => f.code).join(', ')}]`,
    )
    const exact = checkSiblingModFile('modname', ['modname', 'modname.mod'])
    check(
      'mod-file-missing: the exactly-named .mod existing means no finding at all',
      exact.length === 0,
      `codes: [${exact.map((f) => f.code).join(', ')}]`,
    )
    const lonely = checkSiblingModFile('lonelyfolder', ['lonelyfolder', 'descriptor_only'])
    checkSingle('mod-file-missing: no .mod file at all is reported as missing, with no mismatch claim', lonely, CODES.MOD_FILE_MISSING)
  }

  // descriptor-has-path — a `path` key inside descriptor.mod.
  {
    const m = await cloneMod(clean, modDir, 'descriptor_path')
    await put(path.join(m.folder, 'descriptor.mod'), `${descriptorBody(m.name)}path="mod/${m.name}"\n`)
    const { findings } = await validateMod({ name: m.name, folderPath: m.folder, modFilePath: path.join(modDir, `${m.name}.mod`) }, { modDir, gameRoot: syntheticGameRoot })
    checkSingle('descriptor-has-path: path key inside descriptor.mod is a warn', findings, CODES.DESCRIPTOR_HAS_PATH)
    check('descriptor-has-path severity is warn', findings[0]?.severity === 'warn', `severity: ${findings[0]?.severity}`)
  }

  // path-absent — a .mod file with no path key at all is a WARN, not an error.
  //
  // `mod-key-missing` is expected alongside it and is not a duplicate finding: `path-absent` is the
  // note that the mod's folder could not be located, while `mod-key-missing` is the wiki's own
  // "Required: Yes" for the key. The severity assertion below reads findings[0], so it is checked
  // against the `path-absent` entry rather than by position — the set is no longer a singleton.
  {
    const m = await cloneMod(clean, modDir, 'path_absent')
    await put(path.join(modDir, `${m.name}.mod`), `version="0.1.0"\nname="${m.name}"\nsupported_version="1.16.*"\n`)
    const { findings } = await validateMod({ name: m.name, folderPath: m.folder, modFilePath: path.join(modDir, `${m.name}.mod`) }, { modDir, gameRoot: syntheticGameRoot })
    checkSingle('path-absent: a .mod file with no path key at all is a warn, not an error', findings, CODES.PATH_ABSENT, [CODES.MOD_KEY_MISSING])
    const absent = findings.find((f) => f.code === CODES.PATH_ABSENT)
    check('path-absent severity is warn', absent?.severity === 'warn', `severity: ${absent?.severity}`)
  }

  // non-ascii-path — a mod directory whose own path contains a non-ASCII character.
  {
    await mkdir(cjkModDir, { recursive: true })
    const m = await buildCleanMod(cjkModDir, { name: 'cjkmod' })
    const { findings } = await validateMod({ name: m.name, folderPath: m.folder, modFilePath: path.join(cjkModDir, `${m.name}.mod`) }, { modDir: cjkModDir, gameRoot: syntheticGameRoot })
    const codes = findings.map((f) => f.code)
    check(
      'non-ascii-path: a mod path containing 曦 is reported, and nothing else is',
      codes.length === 2 && codes.every((code) => code === CODES.NON_ASCII_PATH),
      `codes: [${codes.join(', ')}]`,
    )
    check(
      'non-ascii-path message carries the wiki sentence verbatim',
      findings[0]?.message.includes('Directory cannot include non English characters'),
      `message starts: ${String(findings[0]?.message).slice(0, 80)}`,
    )
  }

  // localization-bad-entry — a line that looks like an entry but is not shaped like one.
  {
    const m = await cloneMod(clean, modDir, 'bad_entry')
    await put(
      path.join(m.folder, 'localization', 'english', `${m.name}_l_english.yml`),
      Buffer.concat([BOM, Buffer.from('l_english:\n key_one:0 "One"\n KEY_TWO unquoted value\n', 'utf8')]),
    )
    const { findings } = await validateMod({ name: m.name, folderPath: m.folder, modFilePath: path.join(modDir, `${m.name}.mod`) }, { modDir, gameRoot: syntheticGameRoot })
    checkSingle('localization-bad-entry: a malformed entry line is a warn', findings, CODES.LOCALIZATION_BAD_ENTRY)
    check('localization-bad-entry reports the line number', findings[0]?.line === 3, `line: ${findings[0]?.line}`)
  }

  // localization-language-dir — a localization file not under a language directory.
  {
    const m = await cloneMod(clean, modDir, 'loc_dir')
    await put(
      path.join(m.folder, 'localization', `${m.name}_l_english.yml`),
      Buffer.concat([BOM, Buffer.from('l_english:\n key_one:0 "One"\n', 'utf8')]),
    )
    const { findings } = await validateMod({ name: m.name, folderPath: m.folder, modFilePath: path.join(modDir, `${m.name}.mod`) }, { modDir, gameRoot: syntheticGameRoot })
    checkSingle('localization-language-dir: a loc file directly under localization\\ is a warn', findings, CODES.LOCALIZATION_LANGUAGE_DIR)
  }

  // vanilla-path-unknown — a common\ subdirectory with no counterpart in the synthetic vanilla.
  {
    const m = await cloneMod(clean, modDir, 'vanilla_unknown')
    await put(path.join(m.folder, 'common', 'scripted_effect', 'typo.txt'), 'x = {\n}\n') // misspelled on purpose
    const { findings } = await validateMod({ name: m.name, folderPath: m.folder, modFilePath: path.join(modDir, `${m.name}.mod`) }, { modDir, gameRoot: syntheticGameRoot })
    checkSingle('vanilla-path-unknown: no vanilla counterpart → warn', findings, CODES.VANILLA_PATH_UNKNOWN)
    check(
      'vanilla-path-unknown is a spelling prompt and says so — never a claim that the mod is wrong',
      !/invalid/i.test(findings[0]?.message ?? '')
        && /misspelled/i.test(findings[0]?.message ?? '')
        && /not a defect/i.test(findings[0]?.suggestion ?? ''),
      `message: ${findings[0]?.message}`,
    )
  }

  /* The tag-VOCABULARY check was retired, and this is the assertion that it stays retired.
   * `tag-unknown` used to fire on any value outside a 21-item list transcribed from the wiki's
   * `Mod structure` page — a page flagged "last verified for version 1.1" (2023) against a 1.19.0.6
   * install. No tag list exists on disk (the launcher fetches it over the network), and the
   * launcher's own database accepted `"1.16 'Chamfron'"` — a game-version string — with the mod's
   * status `ready_to_play`. A check that flags valid mods, and whose only suggested remedy is to
   * rename the tag, is worse than no check. What remains is the SHAPE test: list vs scalar. */
  {
    const m = await cloneMod(clean, modDir, 'arbitrary_tag')
    await put(path.join(modDir, `${m.name}.mod`), modFileBody(m.name, ['Gameplay', 'NotARealTag']))
    const { findings } = await validateMod({ name: m.name, folderPath: m.folder, modFilePath: path.join(modDir, `${m.name}.mod`) }, { modDir, gameRoot: syntheticGameRoot })
    check(
      'an unrecognised tag in the LIST form is NOT reported (the vocabulary is unsourced and stale)',
      findings.length === 0,
      `codes: [${findings.map((f) => f.code).join(', ')}]`,
    )
  }

  /* ---------------- 4. clean-run regression guards ---------------- */

  // The brace counter must ignore braces inside comments and quoted strings, or it would report
  // healthy files as broken. Both live on the clean fixture's events file already; assert directly.
  //
  // These two strings are written as explicit line arrays because the first version of this test
  // embedded a `\n` inside a single-quoted JavaScript string and mis-counted by hand, which made
  // the *test* wrong rather than the rule. Braces are counted here, not eyeballed:
  //   balanced  : 2 "{" / 2 "}" in code; the "}" inside the string and the three "}" after "#" are
  //               noise, so a scanner that counted them would report 2 "{" / 6 "}".
  //   comment   : 1 "{" / 1 "}" in code; two "}" sit inside a comment.
  check(
    'script-unbalanced: braces inside quoted strings and after # do not count',
    checkScriptBraces('x.txt', ['a = {', '\t"}", "{"', '\t# } } } }', '}'].join('\n')).length === 0,
    'a balanced file whose strings and comments hold six stray "}" produces no finding',
  )
  check(
    'script-unbalanced: a file whose only braces are inside a comment and a string is balanced',
    checkScriptBraces('x.txt', ['a = {', '\t# } } }', '}'].join('\n')).length === 0,
    'one "{" in code and one "}" in code, with a comment between them',
  )
  check(
    'script-unbalanced: a real imbalance is still caught across lines',
    checkScriptBraces('x.txt', ['a = {', '\tb = {', '}'].join('\n')).length === 1,
    '2 open / 1 close → 1 finding',
  )
  check(
    'localization: a raw entry with the version counter is accepted, a bare word is not',
    checkLocalizationFile('f.yml', Buffer.concat([BOM, Buffer.from('l_english:\n A.B-C_1:12 "v"\n', 'utf8')])).length === 0
      && checkLocalizationFile('f.yml', Buffer.concat([BOM, Buffer.from('l_english:\nnope\n', 'utf8')])).length === 1,
    'entry shape matches ^\\s*[A-Za-z0-9_.\\-]+:\\d*\\s*".*"',
  )
  check(
    'checkModPath: existence is a fact, never a claim about the path= format',
    (await checkModPath('m.mod', 'path="mod/nowhere"\n', modDir)).findings.length === 1
      && (await checkModPath('m.mod', `path="${path.join(modDir, clean.name)}"\n`, modDir)).findings.length === 0,
    'a nonexistent target is reported; an existing one is not',
  )
  check(
    'checkModPath returns the resolved path, which is what check 16 compares the folder against',
    (await checkModPath('m.mod', `path="${path.join(modDir, clean.name)}"\n`, modDir)).resolved === path.join(modDir, clean.name),
    'resolved is the normalized path= target',
  )
  check(
    'checkModPath: an UNQUOTED path= value is its own finding, not "no path key"',
    (await checkModPath('m.mod', 'path=mod/nowhere\n', modDir)).findings[0]?.code === 'path-unquoted',
    `code: ${(await checkModPath('m.mod', 'path=mod/nowhere\n', modDir)).findings[0]?.code}`,
  )
  check(
    'checkTags: the exact launcher vocabulary is accepted',
    checkTags('m.mod', 'tags={\n"Total Conversion"\n"Alternative History"\n}\n').length === 0,
    'two real tags produce no finding',
  )
  check(
    'discoverMods: a folder with no sibling .mod is still discovered',
    (await discoverMods(modDir)).some((entry) => entry.name === 'no_sibling' && entry.modFilePath === null),
    `discovered ${(await discoverMods(modDir)).length} targets`,
  )

  /* ---------------- 4b. the fixer, end to end, on its own throwaway fixture ---------------- */

  // The smoke run that drove the real tool caught a bug this section now locks down: `validateMod`
  // did not echo the target back, so the fixer received `modFilePath: undefined` and refused to
  // create the descriptor — the one repair it exists for. A rule-layer test alone did not see it.
  {
    const fixDir = path.join(root, 'fixable')
    const target = await buildCleanMod(fixDir, {
      name: 'fixme',
      locBytes: Buffer.from('l_english:\n k:0 "v"\n', 'utf8'), // deliberately no BOM
    })
    await rm(path.join(target.folder, 'descriptor.mod'), { force: true })
    const before = await validateMod(
      { name: target.name, folderPath: target.folder, modFilePath: path.join(fixDir, `${target.name}.mod`) },
      { modDir: fixDir, gameRoot: syntheticGameRoot },
    )
    check(
      'fixable fixture: exactly the two repairable findings, and nothing else',
      before.findings.map((f) => f.code).sort().join(',') === [CODES.DESCRIPTOR_MISSING, CODES.LOCALIZATION_NO_BOM].sort().join(','),
      `codes: [${before.findings.map((f) => f.code).join(', ')}]`,
    )
    const plan = await planFixes(before, before.findings, fixDir)
    for (const action of plan.actions) await action.run()
    const after = await validateMod(
      { name: target.name, folderPath: target.folder, modFilePath: path.join(fixDir, `${target.name}.mod`) },
      { modDir: fixDir, gameRoot: syntheticGameRoot },
    )
    check(
      'fixer: running every planned action makes the clean fixture clean',
      after.findings.length === 0,
      `remaining: [${after.findings.map((f) => f.code).join(', ')}]`,
    )
    const descriptor = await readFile(path.join(target.folder, 'descriptor.mod'))
    check(
      'fixer: the synthesised descriptor.mod has no `path` line and keeps the other keys',
      !/^\s*path\s*=/im.test(decodeText(descriptor)) && /name="fixme"/.test(decodeText(descriptor)),
      `descriptor: ${JSON.stringify(decodeText(descriptor))}`,
    )
    check(
      'fixer: the localization file now begins with the UTF-8 BOM',
      hasBom(await readFile(path.join(target.folder, 'localization', 'english', 'fixme_l_english.yml'))),
      'first bytes after repair checked',
    )
    check(
      'fixer: it plans nothing for a mod whose path is non-ASCII, and says why',
      (await planFixes({ name: 'cjk', folderPath: cjkModDir, modFilePath: null }, [], cjkModDir)).actions.length === 0
        && (await planFixes({ name: 'cjk', folderPath: cjkModDir, modFilePath: null }, [
          { code: CODES.DESCRIPTOR_MISSING, severity: 'error', file: path.join(cjkModDir, 'descriptor.mod'), line: 0, message: '', suggestion: '' },
        ], cjkModDir)).skipped.some((s) => /non-ASCII/.test(s.reason)),
      'refuses to touch a non-ASCII path',
    )
  }

  /* ---------------- 5. Config — the only coverage it has ---------------- */

  const empty = Config['~standard'].validate({})
  check(
    'Config: validate({}) applies all three defaults',
    empty.value?.gameRoot === VANILLA_ROOT && empty.value?.modDir === 'D:\\CK3Mods' && empty.value?.strict === true,
    `value: ${JSON.stringify(empty.value)}`,
  )
  const undefinedInput = Config['~standard'].validate(undefined)
  check(
    'Config: validate(undefined) applies all three defaults',
    undefinedInput.value?.gameRoot === VANILLA_ROOT && undefinedInput.value?.modDir === 'D:\\CK3Mods' && undefinedInput.value?.strict === true,
    `value: ${JSON.stringify(undefinedInput.value)}`,
  )
  const badStrict = Config['~standard'].validate({ strict: 'yes' })
  check(
    'Config: validate({ strict: "yes" }) returns issues with a non-empty message',
    Array.isArray(badStrict.issues) && badStrict.issues.length > 0 && typeof badStrict.issues[0].message === 'string' && badStrict.issues[0].message.length > 0,
    `issues: ${JSON.stringify(badStrict.issues)}`,
  )
  const bogus = Config['~standard'].validate({ bogus: 1 })
  check(
    'Config: validate({ bogus: 1 }) rejects the unknown field by name',
    Array.isArray(bogus.issues) && bogus.issues.some((issue) => /unknown config field "bogus"/.test(issue.message)),
    `issues: ${JSON.stringify(bogus.issues)}`,
  )
  const overridden = Config['~standard'].validate({ modDir: 'D:\\Other' })
  check(
    'Config: validate({ modDir: "D:\\\\Other" }) keeps that value and defaults the other two',
    overridden.value?.modDir === 'D:\\Other' && overridden.value?.gameRoot === VANILLA_ROOT && overridden.value?.strict === true,
    `value: ${JSON.stringify(overridden.value)}`,
  )
  check(
    'Config: defaults match the exported DEFAULTS object',
    JSON.stringify(empty.value) === JSON.stringify({ ...DEFAULTS }),
    `DEFAULTS: ${JSON.stringify(DEFAULTS)}`,
  )

  /* ---------------- 6. read-only probe against the REAL vanilla install ---------------- */

  const realLoc = path.join(VANILLA_ROOT, 'game', 'localization', 'english', 'achievements_l_english.yml')
  let realBytes = null
  try {
    realBytes = await readFile(realLoc)
  } catch {
    realBytes = null
  }
  if (realBytes === null) {
    check('vanilla probe: skipped — the real vanilla install is not present at ' + VANILLA_ROOT, true, 'skipped (no false failure asserted on a machine without the game)')
  } else {
    check('vanilla probe: the real file really does start with the UTF-8 BOM', hasBom(realBytes), `first bytes: ${[...realBytes.slice(0, 3)].map((b) => b.toString(16)).join(' ')}`)
    check(
      'vanilla probe: its first non-empty line is `l_english:`',
      decodeText(realBytes).split(/\r?\n/).find((line) => line.trim() !== '') === 'l_english:',
      `first line: ${JSON.stringify(decodeText(realBytes).split(/\r?\n/)[0])}`,
    )
    const realFindings = checkLocalizationFile(realLoc, realBytes, true)
    check(
      'vanilla probe: a real vanilla localization file produces ZERO findings',
      realFindings.length === 0,
      `findings: ${realFindings.map((f) => f.code).join(', ') || '(none)'}`,
    )
  }

  /* ---------------- 7. ordering ---------------- */

  const sorted = sortFindings([
    { code: 'warn-b', severity: 'warn', file: 'a.txt', line: 0 },
    { code: 'err-z', severity: 'error', file: 'z.txt', line: 0 },
    { code: 'err-a', severity: 'error', file: 'a.txt', line: 5 },
  ])
  check(
    'sortFindings: errors first, then by path',
    sorted.map((f) => f.code).join(',') === 'err-a,err-z,warn-b',
    `order: ${sorted.map((f) => f.code).join(',')}`,
  )
  check(
    'every code in CODES has a severity in SEVERITY',
    Object.values(CODES).every((code) => SEVERITY[code] === 'error' || SEVERITY[code] === 'warn'),
    `codes: ${Object.values(CODES).length}`,
  )

  /* ---------------------------------------------------------------- *
   * Assertions added from the measured gap analysis
   *
   * Every one of these corresponds to a case that produced ZERO findings
   * before, or to a false positive whose own suggestion would have made a
   * real mod worse. They exist so the gap cannot silently reopen.
   * ---------------------------------------------------------------- */

  check(
    'mod-key-missing: a .mod whose required keys are absent is reported',
    checkModFileKeys('m.mod', 'name="x"\n', { isDescriptor: false })
      .filter((f) => f.code === 'mod-key-missing').length >= 1,
    'version and path missing → at least one mod-key-missing',
  )
  check(
    'mod-key-empty: present-but-blank required keys are their own defect',
    checkModFileKeys('m.mod', 'version=""\nname=""\npath=""\n', { isDescriptor: false })
      .filter((f) => f.code === 'mod-key-empty').length === 3,
    `${checkModFileKeys('m.mod', 'version=""\nname=""\npath=""\n', { isDescriptor: false }).length} findings`,
  )
  check(
    'supported-version-missing fires on the sibling .mod and NOT on descriptor.mod',
    checkModFileKeys('m.mod', 'version="1"\nname="x"\npath="p"\n', { isDescriptor: false })
      .some((f) => f.code === 'supported-version-missing')
      && !checkModFileKeys('descriptor.mod', 'version="1"\nname="x"\n', { isDescriptor: true })
        .some((f) => f.code === 'supported-version-missing'),
    'the wiki marks it "Required for file alongside mod folder; not required for descriptor.mod"',
  )
  check(
    'descriptor.mod legitimately omits `path` and is not reported for it',
    !checkModFileKeys('descriptor.mod', 'version="1"\nname="x"\nsupported_version="1.19.*"\n', { isDescriptor: true })
      .some((f) => f.code === 'mod-key-missing'),
    'no mod-key-missing for a descriptor without a path line',
  )
  check(
    'tags-not-a-list: tags="Gameplay" is reported instead of silently passing',
    checkTags('m.mod', 'tags="Gameplay"\n')[0]?.code === 'tags-not-a-list',
    `code: ${checkTags('m.mod', 'tags="Gameplay"\n')[0]?.code}`,
  )
  check(
    'checkTags: the list form is accepted and the scalar form is the only thing reported',
    checkTags('m.mod', 'tags={\n\t"Gameplay"\n\t"Anything At All"\n}\n').length === 0
      && checkTags('m.mod', 'tags="Gameplay"\n')[0]?.code === 'tags-not-a-list',
    'shape, not vocabulary',
  )
  check(
    'mod-folder-mismatch: a path pointing at ANOTHER existing folder is reported',
    checkModFolderMatchesPath({ folderPath: 'C:\\mods\\mine', modFilePath: 'C:\\mods\\mine.mod' }, 'C:\\mods\\other')
      .some((f) => f.code === 'mod-folder-mismatch'),
    'the resolved path is not this mod folder',
  )
  check(
    'mod-folder-mismatch: the mod\'s own folder is not reported',
    checkModFolderMatchesPath({ folderPath: 'C:\\mods\\mine', modFilePath: null }, 'C:\\mods\\mine').length === 0,
    'same folder, case-insensitively',
  )
  check(
    'replace-path-unknown: a replace_path with no vanilla counterpart is an error',
    (await checkReplacePath('m.mod', 'replace_path="non/existent"\n', syntheticGameRoot))[0]?.code === 'replace-path-unknown',
    'nothing is replaced, so it can only be a typo',
  )
  check(
    'replace-path-destructive: replacing a directory that DOES exist states the consequence',
    (await checkReplacePath('m.mod', 'replace_path="history/characters"\n', syntheticGameRoot))[0]?.code === 'replace-path-destructive',
    'the wiki: "Doesn\'t load vanilla files for the specified path"',
  )
  check(
    'path-case-mismatch: Common\\ next to a vanilla common\\ is reported',
    checkPathCase({ folderPath: 'C:\\mods\\mine' }, ['decisions', 'traits'], ['Decisions'])[0]?.code === 'path-case-mismatch',
    'resolves on Windows, loads nothing on Linux',
  )
  check(
    'path-case-mismatch: an exactly-matching name is not reported',
    checkPathCase({ folderPath: 'C:\\mods\\mine' }, ['decisions'], ['decisions']).length === 0,
    'case agrees with vanilla',
  )
  check(
    'unexpected-extension: a file with no extension under a script root is reported',
    (await checkScriptExtensions({ folderPath: 'C:\\mods\\mine' }, ['events'],
      async () => ['C:\\mods\\mine\\events\\noext', 'C:\\mods\\mine\\events\\ok.txt']))
      .some((f) => f.code === 'unexpected-extension'),
    'only the extensionless file is flagged',
  )
  check(
    'duplicate-localization-key: the second definition is reported and names the first',
    checkDuplicateLocalizationKeys('f.yml', Buffer.concat([BOM, Buffer.from('l_english:\n k:0 "a"\n k:0 "b"\n', 'utf8')]))[0]?.line === 3,
    'reported at the second occurrence',
  )

  /* THE ONE THAT WOULD HAVE HURT A REAL MOD. The wiki states both orderings are valid:
   * "Both `localization/replace/english` and `localization/english/replace` work, but the first
   * path takes precedence over the other." The earlier revision read the segment after
   * `localization` as the language, so `localization\replace\english\` was warned about — and the
   * warning's own suggestion, "move it under localization\english\", would have changed which file
   * wins or stopped the override working. */
  check(
    'localization-language-dir: localization/replace/english is NOT reported (documented override path)',
    checkLocalizationLanguageDir('C:\\mod', 'C:\\mod\\localization\\replace\\english\\e_l_english.yml').length === 0,
    'the wiki documents this path and gives it precedence',
  )
  check(
    'localization-language-dir: localization/english/replace is NOT reported either',
    checkLocalizationLanguageDir('C:\\mod', 'C:\\mod\\localization\\english\\replace\\e_l_english.yml').length === 0,
    'the other documented ordering',
  )
  check(
    'localization-language-dir: a genuinely wrong directory IS still reported',
    checkLocalizationLanguageDir('C:\\mod', 'C:\\mod\\localization\\nonsense\\e_l_english.yml').length === 1,
    'the check did not become a no-op',
  )

  /* Both halves of the BOM asymmetry, asserted together because they are opposite requirements on
   * the same two file families. Decoding strips a BOM before counting braces, which is why a BOM on
   * a script file used to be structurally invisible. */
  check(
    'localization keeps its BOM requirement while script files must NOT have one',
    checkLocalizationFile('f.yml', Buffer.concat([BOM, Buffer.from('l_english:\n k:0 "v"\n', 'utf8')])).length === 0
      && hasBom(Buffer.concat([BOM, Buffer.from('x = { }\n', 'utf8')])),
    'a BOM is required for .yml and detectable on .txt',
  )

  /* ------------------------------------------------------------------ *
   * The event-id and encoding checks, calibrated against the vanilla install
   * ------------------------------------------------------------------ */

  check(
    'event-id-out-of-range: an id above 9999 is reported, 9999 itself is not',
    checkEventIds('x.txt', 'ns.12345 = {\n}\n', 'ns').some((f) => f.code === 'event-id-out-of-range')
      && checkEventIds('x.txt', 'ns.9999 = {\n}\n', 'ns').length === 0,
    'Event modding: "if the ID exceeds 9999, the event calling system will become buggy"',
  )
  check(
    'event-file-empty: a namespace with no event under it is reported',
    checkEventIds('x.txt', 'namespace = ns\n', 'ns')[0]?.code === 'event-file-empty',
    'a file under events\\ that defines no event is read by nothing',
  )
  check(
    'event-file-empty: a file WITH an event is not reported',
    checkEventIds('x.txt', 'namespace = ns\nns.1 = {\n}\n', 'ns').length === 0,
    'the normal case stays clean',
  )
  check(
    'text-not-utf8: a UTF-16 BOM and invalid UTF-8 are both reported; plain UTF-8 is not',
    checkTextEncoding('x.txt', Buffer.from([0xff, 0xfe, 0x61, 0x00]))[0]?.code === 'text-not-utf8'
      && checkTextEncoding('x.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9]))[0]?.code === 'text-not-utf8'
      && checkTextEncoding('x.txt', Buffer.from('x = { }\n', 'utf8')).length === 0,
    'TextDecoder fatal is the test, not a heuristic',
  )
  check(
    'text-not-utf8 does NOT re-report a UTF-8 BOM (script-has-bom owns that)',
    checkTextEncoding('x.txt', Buffer.concat([BOM, Buffer.from('x = { }\n', 'utf8')])).length === 0,
    'one byte sequence, one code',
  )

  /* The calibration that matters for both new checks: they must not fire on the game's own files.
   * Measured over the whole vanilla install — 2,536 `common` scripts plus 536 event files — the
   * encoding check produces ZERO findings, and the namespace check produces exactly 20 (19 prefix
   * mismatches + 1 file declaring no namespace), which is the same census an independent pass
   * reported (516 of 536 conform). A non-zero encoding count here means the check has begun crying
   * wolf on the game's own tree, which is the failure this plugin already had to fix once. */
  {
    const vanillaCommon = path.join(VANILLA_ROOT, 'game', 'common')
    const vanillaEvents = path.join(VANILLA_ROOT, 'game', 'events')
    if (existsSync(vanillaCommon)) {
      const commonScripts = await collectFiles(vanillaCommon, { extensions: ['.txt'] })
      const eventScripts = await collectFiles(vanillaEvents, { extensions: ['.txt'] })
      let encodingFindings = 0
      for (const f of [...commonScripts, ...eventScripts]) {
        encodingFindings += checkTextEncoding(f, await readFile(f)).length
      }
      check(
        'vanilla calibration: the encoding check reports ZERO findings on the whole vanilla tree',
        encodingFindings === 0,
        `${commonScripts.length} common + ${eventScripts.length} event script(s), ${encodingFindings} finding(s)`,
      )
      let namespaceFindings = 0
      for (const f of eventScripts) {
        namespaceFindings += checkEventNamespace(f, decodeText(await readFile(f))).length
      }
      check(
        'vanilla calibration: the namespace check reports exactly 20 on the vanilla event tree',
        namespaceFindings === 20,
        `${eventScripts.length} event file(s), ${namespaceFindings} finding(s) — 19 mismatches + 1 missing is the recorded census`,
      )
    } else {
      console.log('  note  vanilla calibration skipped: the vanilla install is not present here')
    }
  }

  /* THE WIKI'S HEADLINE WARNING, and the one failure every other check misses: a file that is
   * perfectly well-formed while quietly replacing a whole vanilla file.
   *   "If a mod has the same file as the game, it replaces all the contents of the file. (By the
   *    same file we mean same path, same filename). Avoid doing this unless you intend to overwrite
   *    the whole file!"
   * A NEW filename is additive — the vanilla tree does exactly that to itself in
   * `common\governments\`, which carries both `00_government_types.txt` and
   * `01_japan_government_types.txt`. So the assertion that matters as much as the positive one is
   * that a new filename is NOT reported. */
  {
    const m = await cloneMod(clean, modDir, 'override')
    // (a) exact-path override of a file vanilla ships
    await put(path.join(m.folder, 'events', 'birth_events.txt'), 'namespace = mine\nmine.1 = {\n}\n')
    // (b) exact-path override of a SINGLE-FILE database — the highest-stakes case
    await put(path.join(m.folder, 'common', 'traits', '00_traits.txt'), 'my_trait = {\n}\n')
    // (c) a NEW filename beside it — additive, must stay silent
    await put(path.join(m.folder, 'common', 'traits', '99_my_own_traits.txt'), 'my_trait = {\n}\n')
    const overrides = await checkVanillaOverrides({ folderPath: m.folder }, VANILLA_ROOT)
    const codes = overrides.map((f) => f.code).sort()
    check(
      'vanilla-file-overridden: an exact-path override of a vanilla file is reported',
      codes.includes('vanilla-file-overridden'),
      `codes from (a)+(b)+(c): [${codes.join(', ')}]`,
    )
    check(
      'vanilla-single-file-database-override: overriding common\\traits is an error, not a warning',
      overrides.find((f) => f.file.includes('00_traits.txt'))?.code === 'vanilla-single-file-database-override'
        && overrides.find((f) => f.file.includes('00_traits.txt'))?.severity === 'error',
      'game/common/traits ships as a single data file',
    )
    check(
      'a NEW filename in a vanilla directory is NOT an override (it is additive)',
      !overrides.some((f) => f.file.includes('99_my_own_traits')),
      'the vanilla tree adds new filenames to itself; 00_ and 01_ coexist in common/governments',
    )
  }

  /* The launcher plane. Its REAL database is machine state (this machine has one leftover entry for
   * a mod that no longer exists), so these assertions drive the comparison with synthetic input —
   * deterministic, and they pin the branch that matters: `dirPath` is the launcher's own record and
   * must win over a path reconstructed from the workspace, because the launcher's default mod
   * directory is `Documents\...\mod`, outside `modDir` entirely. */
  {
    // A live entry: `dirPath` must actually contain a `descriptor.mod`, because that is the file the
    // check looks for inside a launcher-recorded folder.
    const liveDir = path.join(root, 'launcher-live')
    await mkdir(liveDir, { recursive: true })
    await put(path.join(liveDir, 'descriptor.mod'), 'version="1"\nname="real"\n')
    const alive = { available: true, mods: [{ dirPath: liveDir, displayName: 'real', registryFile: 'real.mod', status: 'ready_to_play', metadataStatus: 'not_applied' }] }
    check(
      'launcher comparison: a registered mod whose dirPath exists is NOT reported',
      compareLauncherToDisk(alive, modDir).length === 0,
      'the normal case stays silent',
    )
    const dead = { available: true, mods: [{ dirPath: path.join(root, 'gone'), displayName: 'gone', registryFile: 'gone.mod', status: 'ready_to_play', metadataStatus: null }] }
    check(
      'launcher-entry-dead: a registered mod whose dirPath is gone IS reported',
      compareLauncherToDisk(dead, modDir)[0]?.code === 'launcher-entry-dead',
      'a dead entry in the picker',
    )
    const broken = { available: true, mods: [{ dirPath: root, displayName: 'bad', registryFile: 'bad.mod', status: 'validation_error', metadataStatus: 'validation_error' }] }
    check(
      'launcher-reports-problem: the launcher\'s own error verdict is surfaced as an error',
      compareLauncherToDisk(broken, modDir).some((f) => f.code === 'launcher-reports-problem' && f.severity === 'error'),
      'the launcher validates against real game data, so its verdict outranks ours',
    )
    check(
      'launcher comparison: an unavailable database produces NO findings (absence is not a defect)',
      compareLauncherToDisk({ available: false, reason: 'no db', mods: [] }, modDir).length === 0,
      'a machine where the launcher never ran must not report every mod as unregistered',
    )
    const state = await readLauncherState(path.join(root, 'no-such-launcher-dir'))
    check(
      'readLauncherState: a missing database returns a reason instead of throwing',
      state.available === false && typeof state.reason === 'string' && state.reason.length > 0,
      `${state.reason?.slice(0, 60)}…`,
    )
  }

  /* THE GENERATOR MUST SATISFY THE VALIDATOR. This is the assertion that makes `ck3_mod_init` worth
   * having: a scaffolder whose own output its own checker rejects is worse than no scaffolder, and
   * that failure would be invisible without exactly this test. */
  {
    const initDir = path.join(root, 'init-mods')
    const made = await scaffoldMod({ modDir: initDir, name: 'genmod', tags: ['Gameplay', 'Events'], systems: ['localization', 'events', 'decisions'] })
    check(
      'scaffoldMod: creates the two .mod files, the localization file and the requested systems',
      made.created.length === 5 && made.refused.length === 0,
      `${made.created.length} created, ${made.refused.length} refused`,
    )
    // The generated skeleton's own properties must count as known before it is validated, for the
    // same reason the other fixtures are seeded: this tree is synthetic and starts empty.
    await seedSyntheticVocabulary([made.folder])
    clearVanillaKeyCache()
    const verdict = await validateMod(
      { name: 'genmod', folderPath: made.folder, modFilePath: made.modFile },
      { modDir: initDir, gameRoot: syntheticGameRoot, strict: true },
    )
    check(
      'scaffoldMod: the generated mod passes every check with ZERO findings',
      verdict.findings.length === 0,
      `codes: [${verdict.findings.map((f) => f.code).join(', ')}]`,
    )
    const locBytes = await readFile(path.join(made.folder, 'localization', 'english', 'genmod_l_english.yml'))
    const scriptBytes = await readFile(path.join(made.folder, 'events', 'genmod_events.txt'))
    check(
      'scaffoldMod: the BOM lands on the localization file and NOT on the script file',
      hasBom(locBytes) && !hasBom(scriptBytes),
      `loc BOM=${hasBom(locBytes)}, script BOM=${hasBom(scriptBytes)} — the asymmetry is the point`,
    )
    const modText = await readFile(made.modFile, 'utf8')
    const descText = await readFile(path.join(made.folder, 'descriptor.mod'), 'utf8')
    check(
      'scaffoldMod: descriptor.mod omits `path` while the sibling .mod carries it',
      modText.includes('path=') && !descText.includes('path='),
      'the wiki: the descriptor excludes "the line containing the path key"',
    )
    const second = await scaffoldMod({ modDir: initDir, name: 'genmod', systems: ['localization', 'events', 'decisions'] })
    check(
      'scaffoldMod NEVER overwrites: a second run creates nothing and refuses every existing file',
      second.created.length === 0 && second.refused.length === 5,
      `2nd run: ${second.created.length} created, ${second.refused.length} refused`,
    )
    const third = await scaffoldMod({ modDir: initDir, name: 'genmod', systems: ['localization'], ifExists: 'overwrite' })
    check(
      'scaffoldMod: ifExists="overwrite" is the only way it rewrites',
      third.created.length > 0 && third.refused.length === 0,
      `${third.created.length} rewritten on an explicit opt-in`,
    )
  }

  /* ------------------------------------------------------------------ *
   * 15b. FUNCTIONAL correctness of the generator — the assertions whose ABSENCE let six
   *      real defects ship while the suite passed 107/107.
   *
   * Every assertion above this point tests *structure*: that files exist, that the BOM is
   * where it belongs, that the validator accepts the output. A skeleton can satisfy all of
   * them and still be unable to show a player anything — which is exactly what happened.
   * Measured four example defects, each of which passed the whole suite:
   *
   *   `icon = "decision_icon.png"`  — `icon` is documented only inside a `widget` -> `item`
   *                                   block (`game\common\decisions\_decisions.info:163`).
   *                                   The decision-level key is `picture` (`:16`-`:24`).
   *   `theme = realm_management`    — not a theme in `game\common\event_themes\00_event_themes.txt`.
   *   `is_triggered_only = yes`     — the CK2 spelling; vanilla never uses it at event level.
   *   no `trigger_event` anywhere   — the event exists as dead text that nothing can fire.
   *
   * These are written as INVARIANTS read out of the generated bytes, not as a golden file, so
   * they keep holding when the generator's output changes shape legitimately. Each `check`
   * below couples the assertion to a known-bad value it must reject, so a broken assertion
   * fails loudly instead of passing vacuously. */
  {
    const invariantsDir = path.join(root, 'invariant-mods')
    const inv = await scaffoldMod({
      modDir: invariantsDir,
      name: 'invmod',
      tags: ['Gameplay'],
      systems: ['localization', 'events', 'decisions'],
    })
    await scaffoldMod({ modDir: invariantsDir, name: 'lone', tags: ['Gameplay'], systems: ['localization', 'events'] })

    const invDecision = await readFile(path.join(inv.folder, 'common', 'decisions', 'invmod_decisions.txt'), 'utf8')
    const invEvent = await readFile(path.join(inv.folder, 'events', 'invmod_events.txt'), 'utf8')
    const loneEvent = await readFile(path.join(invariantsDir, 'lone', 'events', 'lone_events.txt'), 'utf8')
    const invLocBytes = await readFile(path.join(inv.folder, 'localization', 'english', 'invmod_l_english.yml'))

    /* ---- the parsers these assertions need. Both are deliberately small and total: they
     * return what they found rather than throwing, so a malformed emission shows up as a
     * failed assertion with the observed value in the detail string, not as a crash. ---- */

    /**
     * Strip a `#` comment while respecting quoted strings, preserving leading whitespace.
     *
     * Whitespace is preserved because `depthOf` reads indentation to find a block's top level.
     * Comment-aware because vanilla's own `is_triggered_only` occurrence lives INSIDE a comment:
     * a naive strip would count it and make the "vanilla never uses this" assertion lie.
     *
     * @param line - the raw line.
     * @returns the line with any comment removed.
     */
    const stripComment = (line) => {
      let inQuote = false
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i]
        if (ch === '"') inQuote = !inQuote
        else if (ch === '#' && !inQuote) return line.slice(0, i)
      }
      return line
    }

    /**
     * The depth-1 `key = value` entries of one named block.
     *
     * `depth` starts at 2 because the opener's own line is consumed by the `continue` above, so
     * its `{` is never counted by the loop — which is exactly the off-by-one that made the first
     * version of these helpers read every entry one level too shallow and report a correct
     * decision as having no call site.
     *
     * @param text - the file body.
     * @param blockName - the top-level block whose own entries are wanted.
     * @returns objects of `{ key, value }` for every depth-1 scalar assignment.
     */
    const blockEntries = (text, blockName) => {
      const out = []
      let depth = 0
      let inside = false
      for (const raw of splitLines(text)) {
        const line = stripComment(raw).trim()
        if (!inside) {
          if (new RegExp(`^${blockName}\\s*=\\s*\\{`).test(line)) { inside = true; depth = 2 }
          continue
        }
        if (line) {
          const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(line)
          if (m && depth === 2) out.push({ key: m[1], value: m[2] })
        }
        depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length
        if (depth <= 0) break
      }
      return out
    }

    const invDecisionEntries = blockEntries(invDecision, 'invmod_decision')
    const invEventEntries = blockEntries(invEvent, 'invmod.0001')

    /**
     * Every `key = value` at depth 2 inside a named depth-1 block of a decision.
     *
     * The call site lives here, not at depth 1: the generator writes `trigger_event` inside
     * `effect = { ... }`, which is where CK3 evaluates it. Asserting this at depth 1 was the
     * first version of this assertion and it failed against CORRECT output — the check was
     * wrong, not the generator.
     *
     * @param text - the file body.
     * @param outer - the depth-1 block, e.g. `effect`.
     * @returns objects of `{ key, value }` for every depth-2 assignment inside it.
     */
    const nestedEntries = (text, outer) => {
      const out = []
      let depth = 0
      let inside = false
      for (const raw of splitLines(text)) {
        const line = stripComment(raw).trim()
        if (!inside) {
          if (new RegExp(`^${outer}\\s*=\\s*\\{`).test(line)) { inside = true; depth = 2 }
          continue
        }
        if (line) {
          const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(line)
          if (m && depth === 2) out.push({ key: m[1], value: m[2] })
        }
        depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length
        if (depth <= 0) break
      }
      return out
    }

    /* ---- DECISION: the decision-level key is `picture`, and `icon` must NOT appear at
     * depth 1. The coupled negative is the old emitted value, which this must reject. ---- */
    const pictureEntry = invDecisionEntries.find((e) => e.key === 'picture')
    const iconAtDepth1 = invDecisionEntries.filter((e) => e.key === 'icon')
    check(
      'scaffoldMod: the decision carries NO depth-1 `icon` (that key lives only in a widget->item block)',
      iconAtDepth1.length === 0,
      iconAtDepth1.length === 0
        ? 'absent, as `_decisions.info` documents'
        : `found ${iconAtDepth1.map((e) => `icon = ${e.value}`).join(', ')} — the old "icon = decision_icon.png" shape`,
    )
    check(
      'scaffoldMod: the decision carries `picture = { reference = "<...>.dds" }`, and the old .png value would fail this',
      pictureEntry !== undefined
        && /\.dds"?\s*\}$/.test(pictureEntry.value)
        && !/"decision_icon\.png"/.test(invDecision),
      `picture entry: ${pictureEntry ? pictureEntry.value : '(absent)'}`,
    )

    /* ---- EVENT: a theme that the game actually defines, read from the install's own theme
     * list rather than a copied subset. 904 theme blocks, measured over `00_event_themes.txt`. ---- */
    const themeListPath = path.join(VANILLA_ROOT, 'game', 'common', 'event_themes', '00_event_themes.txt')
    let declaredThemes = null
    try {
      const themeText = await readFile(themeListPath, 'utf8')
      declaredThemes = new Set()
      for (const raw of splitLines(themeText)) {
        const line = stripComment(raw).trim()
        if (!line) continue
        const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{/.exec(line)
        if (!m) continue
        // Themes are depth-1 blocks. Every other `key = {` here is a nested property such as
        // `icon` or `background` inside one, so indentation is what separates them.
        if (/^[\t ]/.test(stripComment(raw))) continue
        declaredThemes.add(m[1])
      }
    } catch { declaredThemes = null }
    const themeEntries = invEventEntries.filter((e) => e.key === 'theme')
    const emittedTheme = themeEntries.length ? themeEntries[0].value.replace(/"/g, '') : null
    if (declaredThemes) {
      check(
        `scaffoldMod: the event's theme is one the install defines (${declaredThemes.size} declared), not the old realm_management`,
        emittedTheme !== null && declaredThemes.has(emittedTheme) && !declaredThemes.has('realm_management'),
        `emitted theme = ${emittedTheme}; in the install's list: ${emittedTheme !== null && declaredThemes.has(emittedTheme)}; `
          + `control value realm_management in that list (must be false): ${declaredThemes.has('realm_management')}`,
      )
    } else {
      check(
        'scaffoldMod: the event theme invariant could not be read (vanilla theme list absent)',
        false,
        `expected ${themeListPath}`,
      )
    }

    /* ---- EVENT: the CK2 spelling must not appear AT ALL, at any depth. ---- */
    const triggeredOnly = /(^|[^\w])is_triggered_only\s*=/.test(stripComment(invEvent).replace(/^\s*#.*$/gm, ''))
    check(
      'scaffoldMod: the event does not use `is_triggered_only` (vanilla never uses it at event level)',
      !triggeredOnly,
      triggeredOnly ? 'FOUND the CK2 spelling' : 'absent',
    )

    /* ---- EVENT: identity fields without which the event cannot render. ---- */
    check(
      'scaffoldMod: the emitted event has type/title/desc — the fields an event needs to render',
      ['type', 'title', 'desc'].every((k) => invEventEntries.some((e) => e.key === k)),
      `depth-1 keys: [${invEventEntries.map((e) => e.key).join(', ')}]`,
    )

    /* ---- REACHABILITY: the decisions block must be what fires the event. This is the one
     * defect class no checker can reach (D-67): a mod can pass every check and show nothing. ---- */
    const triggerEvents = nestedEntries(invDecision, 'effect').filter((e) => e.key === 'trigger_event')
    const definedEventId = 'invmod.0001'
    check(
      'scaffoldMod: the decision\'s effect calls the event, so the emitted event is reachable and not dead text',
      triggerEvents.length === 1 && invEvent.includes(`${definedEventId} = {`)
        && triggerEvents[0].value.trim() === definedEventId,
      `trigger_event inside effect: [${triggerEvents.map((e) => e.value).join(', ')}], event ${definedEventId} defined: ${invEvent.includes(`${definedEventId} = {`)}`,
    )
    /* ...and the coupling is CONDITIONAL, asserted both ways: with only the events system there
     * is no decision to hold the call, so the generator must not invent one. */
    check(
      'scaffoldMod: events-without-decisions emits no call site and no decision file (the coupling is conditional)',
      !/trigger_event/.test(loneEvent) && !(await (async () => { try { await readFile(path.join(invariantsDir, 'lone', 'common', 'decisions', 'lone_decisions.txt')); return true } catch { return false } })()),
      'the events-only run wrote no decision and no trigger_event',
    )

    /* ---- LOCALIZATION: every key the generated scripts reference must be DEFINED, and the
     * emitted set must be exactly what is referenced. The old shape referenced two keys the
     * localization file did not carry, which renders raw text in the interface. ---- */
    const locText = new TextDecoder('utf-8').decode(invLocBytes).replace(/^\uFEFF/, '')
    const locEntries = new Map()
    for (const raw of splitLines(locText)) {
      const line = stripComment(raw)
      if (!line.trim() || /^l_[a-z_]+:\s*$/.test(line.trim())) continue
      const m = /^\s*([A-Za-z0-9_.\-']+):(\d+)?\s+"(.*)"\s*$/.exec(line)
      if (m) locEntries.set(m[1], m[3])
    }
    const referenced = new Set()
    /* CK3's localization convention, read off the generated output rather than assumed:
     * the event's `option` label is a key (`name = "invmod_greeting"`), `title`/`desc` resolve a
     * key with the same name, and the decision's interface text is `<decision>` plus
     * `<decision>_desc` — the pair the OLD shape omitted, which is the defect this guards.
     * A first version of this assertion demanded `<title>_desc` unconditionally and failed against
     * correct output: the generator is not obliged to define one. */
    for (const m of invEvent.matchAll(/^\s*(?:title|desc)\s*=\s*"?([A-Za-z0-9_.\-]+)"?\s*$/gm)) referenced.add(m[1])
    for (const m of invEvent.matchAll(/^\s*name\s*=\s*"([A-Za-z0-9_.\-]+)"\s*$/gm)) referenced.add(m[1])
    referenced.add('invmod_decision')
    referenced.add('invmod_decision_desc')
    const missing = [...referenced].filter((k) => !locEntries.has(k))
    check(
      'scaffoldMod: every localization key the generated scripts reference is defined in the .yml',
      missing.length === 0,
      missing.length === 0
        ? `all ${referenced.size} referenced keys defined (entries: [${[...locEntries.keys()].join(', ')}])`
        : `UNDEFINED: [${missing.join(', ')}] — the old shape referenced the decision key it never emitted`,
    )
  }

  /* THE RUNTIME EVIDENCE PLANE. Its three states are the whole point: "no logs", "logs created but
   * nothing flushed", and "logs populated" are three different answers, and treating any two as the
   * same is how a reader ends up reporting an empty error.log as "no errors". The `parseLogLine`
   * assertions use the two line shapes measured from a real 1.19.0.6 launch. */
  {
    check(
      'parseLogLine: the measured debug shape parses to D + source + message',
      (() => { const r = parseLogLine('[23:17:39][D][jomini_game_setup.cpp:326]: Log system initialized.'); return r.severity === 'D' && r.source === 'jomini_game_setup.cpp:326' && r.message === 'Log system initialized.' })(),
      'the real format the engine writes',
    )
    check(
      'parseLogLine: the measured warning shape parses, and an unshaped line keeps severity null',
      parseLogLine('[23:18:27][W][provincetemplate.cpp:158]: Province 10186 has no pixels!').severity === 'W'
        && parseLogLine('a line with no prefix').severity === null,
      'an unparsed line is preserved, not dropped — a changed format must stay visible',
    )
    check(
      'parseEventLog: rows are read and checked=0 is collected as never-fired',
      (() => {
        const r = parseEventLog({ name: 'event_log.csv', bytes: 60, text: 'event,checked,picked\nns.1,0,0\nns.2,5,3\nother.9,0,1\n' })
        return r !== null && r.rows.length === 3 && r.neverChecked.map((x) => x.id).join(',') === 'ns.1,other.9'
      })(),
      'the reachability signal static analysis cannot see',
    )
    check(
      'parseEventLog: an unrecognised header returns null, never an empty report',
      parseEventLog({ name: 'event_log.csv', bytes: 9, text: 'a,b\n1,2\n' }) === null
        && parseEventLog({ name: 'event_log.csv', bytes: 0, text: '' }) === null,
      '"I could not read it" must not look like "nothing is wrong"',
    )
    /* The engine writes this file, so its shape is not ours to choose. `event_log.csv` has never
     * been produced on this machine (D-69 — the unlocking console command has still not been run),
     * which means the parser's tolerance is the ONLY thing standing between "the file finally
     * appeared" and a silent misread. These are the format variations that could plausibly arrive:
     * a different delimiter, a different column order, extra columns, quoting, CRLF, and an
     * uppercase header. All eight must read identically; a shape it cannot read must be `null`
     * rather than a short row list, because a short list is indistinguishable from "no problems". */
    {
      const NL = '\n'
      const CR = '\r'
      const shapes = [
        ['comma', ['event,checked', 'ns.1,0', 'ns.2,5'], NL],
        ['semicolon', ['event;checked', 'ns.1;0', 'ns.2;5'], NL],
        ['quoted', ['"event","checked"', '"ns.1","0"', '"ns.2","5"'], NL],
        ['CRLF', ['event,checked', 'ns.1,0', 'ns.2,5'], CR + NL],
        ['reversed columns', ['checked,event', '0,ns.1', '5,ns.2'], NL],
        ['id + times_checked', ['id,times_checked', 'ns.1,0', 'ns.2,5'], NL],
        ['extra columns', ['index,event,checked,picked', '1,ns.1,0,0', '2,ns.2,5,3'], NL],
        ['uppercase header', ['EVENT,CHECKED', 'ns.1,0', 'ns.2,5'], NL],
      ]
      const results = shapes.map(([label, lines, eol]) => {
        const text = lines.join(eol) + eol
        const r = parseEventLog({ name: 'event_log.csv', bytes: Buffer.byteLength(text), text })
        const ok = r !== null && r.rows.length === 2 && r.neverChecked.length === 1 && r.neverChecked[0].id === 'ns.1'
        return `${label}=${ok ? 'ok' : r === null ? 'NULL' : `${r.rows.length}rows`}`
      })
      check(
        'parseEventLog: tolerates every plausible engine format identically (delimiter, order, quoting, CRLF, extra columns, case)',
        results.every((r) => r.endsWith('=ok')),
        results.join('  '),
      )
      check(
        'parseEventLog: a header-only or unreadable file is null, not an empty-but-successful report',
        parseEventLog({ name: 'event_log.csv', bytes: 13, text: 'event,checked' + NL }) === null
          && parseEventLog({ name: 'event_log.csv', bytes: 3, text: '  ' + NL }) === null,
        'a one-line file has no rows to report, so "read nothing" must not read as "clean"',
      )
    }

    const none = await readRuntimeEvidence(path.join(root, 'no-such-logs'))
    check(
      'readRuntimeEvidence: a missing logs directory is unavailable with a reason, not an error',
      none.available === false && typeof none.reason === 'string' && none.findings.length === 0,
      `available=${none.available}`,
    )

    // Created-but-empty: the state a game is in while still loading. It must be its own answer.
    const emptyLogs = path.join(root, 'logs-empty')
    await mkdir(emptyLogs, { recursive: true })
    await put(path.join(emptyLogs, 'error.log'), '')
    const pending = await readRuntimeEvidence(emptyLogs)
    check(
      'readRuntimeEvidence: created-but-empty logs report flushed=false (NOT "no errors")',
      pending.available === true && pending.flushed === false && pending.findings.length === 0,
      `available=${pending.available}, flushed=${pending.flushed} — the distinction the reader exists to preserve`,
    )

    // Populated, with a real vanilla-style warning line and an event log carrying a never-fired row.
    const liveLogs = path.join(root, 'logs-populated')
    await mkdir(liveLogs, { recursive: true })
    await put(path.join(liveLogs, 'setup.log'), '[23:18:27][W][provincetemplate.cpp:158]: Province 10186 has no pixels!\n')
    await put(path.join(liveLogs, 'event_log.csv'), 'event,checked,picked\nns.1,0,0\nns.2,5,3\n')
    const live = await readRuntimeEvidence(liveLogs)
    check(
      'readRuntimeEvidence: a vanilla-style W line is COUNTED but raises no finding of its own',
      live.flushed === true
        && live.files.find((f) => f.name === 'setup.log')?.bySeverity.W === 1
        && live.findings.every((f) => f.code === 'event-never-fired'),
      'a non-empty log is not evidence of a defect — measured: 512 such warnings with no mod enabled',
    )
    check(
      'readRuntimeEvidence: checked=0 raises event-never-fired, and only for those rows',
      live.findings.length === 1 && live.findings[0].code === 'event-never-fired' && live.findings[0].message.includes('ns.1'),
      `${live.findings.length} finding(s)`,
    )

    /* DEDUPLICATION ACROSS SINKS — measured on a real launch, where the same two E-level messages
     * appeared in debug.log, error.log AND game.log and a per-file sum therefore reported 6. */
    const sinks = path.join(root, 'logs-sinks')
    await mkdir(sinks, { recursive: true })
    const sameLine = '[23:24:08][E][landed_title_name_util.cpp:853]: Failed to find any valid flavorization for title\n'
    for (const name of ['debug.log', 'error.log', 'game.log']) await put(path.join(sinks, name), sameLine)
    const dupe = await readRuntimeEvidence(sinks)
    const rawE = dupe.files.reduce((n, f) => n + f.bySeverity.E, 0)
    check(
      'readRuntimeEvidence: one message in three sinks counts as 1 distinct error, not 3',
      rawE === 3 && dupe.distinctErrors.length === 1 && dupe.distinctErrors[0].files.length === 3,
      `raw=${rawE}, distinct=${dupe.distinctErrors.length}, sinks=${dupe.distinctErrors[0]?.files.join('+')}`,
    )
    check(
      'readRuntimeEvidence: distinctErrors keeps the source and every sink it appeared in',
      dupe.distinctErrors[0].source === 'landed_title_name_util.cpp:853'
        && dupe.distinctErrors[0].files.sort().join(',') === 'debug.log,error.log,game.log',
      `${dupe.distinctErrors[0].source}`,
    )
  }

  /* THE DESTRUCTIVE PATH, EXERCISED END TO END. The suite previously asserted `planFixes` (which
   * only computes a plan) and never `applyFixes` — the single function that writes to disk. Two
   * properties matter and neither was covered: the repairs actually land, and a second run is a
   * no-op rather than re-writing the same bytes forever. */
  {
    const m = await cloneMod(clean, modDir, 'fixable')
    // Take the clean mod apart in exactly the two ways the fixer claims to repair.
    await rm(path.join(m.folder, 'descriptor.mod'), { force: true })
    const locPath = path.join(m.folder, 'localization', 'english', `${m.name}_l_english.yml`)
    await put(locPath, Buffer.from('l_english: \n fixmod_key:0 "x"\n', 'utf8'))

    const before = await validateMod({ name: m.name, folderPath: m.folder, modFilePath: path.join(modDir, `${m.name}.mod`) }, { modDir, gameRoot: syntheticGameRoot })
    const beforeCodes = before.findings.map((f) => f.code)
    check(
      'applyFixes precondition: the two repairable defects are present',
      beforeCodes.includes(CODES.DESCRIPTOR_MISSING) && beforeCodes.includes(CODES.LOCALIZATION_NO_BOM),
      `codes: [${beforeCodes.join(', ')}]`,
    )

    const applied = await applyFixes([before], modDir)
    check(
      'applyFixes: both repairs are applied',
      applied.applied.length === 2 && applied.skipped.length === 0,
      `applied ${applied.applied.length}, skipped ${applied.skipped.length}`,
    )

    const after = await validateMod({ name: m.name, folderPath: m.folder, modFilePath: path.join(modDir, `${m.name}.mod`) }, { modDir, gameRoot: syntheticGameRoot })
    check(
      'applyFixes: the mod validates clean afterwards',
      after.findings.length === 0,
      `codes after: [${after.findings.map((f) => f.code).join(', ')}]`,
    )
    check(
      'applyFixes: the BOM is really on disk, not just in the plan',
      hasBom(await readFile(locPath)),
      'first three bytes of the localization file',
    )

    const second = await applyFixes([after], modDir)
    check(
      'applyFixes is idempotent: a second run applies nothing',
      second.applied.length === 0,
      `2nd run applied ${second.applied.length}`,
    )
  }

  /* ------------------------------------------------------------------ *
   * 16. THE SCRIPTING-VOCABULARY CHECK — vanilla-key-unknown and event-theme-unknown.
   *
   * D-73's finding was that a skeleton with six real defects produced `0 findings`. Two of the six
   * are reachable this way and neither was checked before: a property vanilla never uses anywhere,
   * and a `theme` value the install does not define.
   *
   * Both assertions are written against the SYNTHETIC vanilla tree, extended here with the keys the
   * fixtures legitimately use. That keeps the suite hermetic — no dependency on the game being
   * installed — while still exercising the real comparison, and it means the assertion fails if the
   * depth cut is wrong in either direction: too shallow and the fixture's own keys are all reported,
   * too deep and `is_triggered_only` is missed. The synthetic theme list deliberately contains
   * `realm` and deliberately does NOT contain `realm_management`, so both branches are pinned. */
  {
    const vocabDir = path.join(root, 'vocab-mods')
    const vocabMod = await scaffoldMod({
      modDir: vocabDir,
      name: 'vocabmod',
      tags: ['Gameplay'],
      systems: ['localization', 'events', 'decisions'],
    })
    const TAB = String.fromCharCode(9)

    // Add this block's fixture keys to the synthetic vocabulary, then let the next read rebuild the
    // cached set from the enlarged tree. The seed is INCREMENTAL — an earlier version replaced the
    // file, which silently deleted the vocabulary the `applyFixes` block relies on.
    await seedSyntheticVocabulary([vocabMod.folder])
    clearVanillaKeyCache()

    // The theme list contains `realm` and deliberately NOT `realm_management`, so both branches are
    // pinned. `icon` appears here only NESTED, which is the case `readDeclaredThemes` must skip.
    await put(
      path.join(syntheticGameRoot, 'game', 'common', 'event_themes', '00_event_themes.txt'),
      `### EVENT THEMES LIST ###\n\nrealm = {\n${TAB}icon = { reference = "gfx/interface/icons/event_types/type_domain.dds" }\n}\n`,
    )

    const declared = await readDeclaredThemes(syntheticGameRoot)
    check(
      'readDeclaredThemes: returns only unindented theme blocks, skipping nested properties',
      declared.size === 1 && declared.has('realm') && !declared.has('icon'),
      `declared: [${[...declared].join(', ')}] — a nested \`icon\` must not appear as a theme`,
    )

    const cleanVocab = await checkVanillaKeys(
      { name: vocabMod.name, folderPath: vocabMod.folder, modFilePath: null },
      syntheticGameRoot,
    )
    check(
      'checkVanillaKeys: a correct skeleton reports NO unknown key and NO unknown theme',
      cleanVocab.length === 0,
      cleanVocab.length === 0
        ? `silent over ${(await syntheticVocabulary()).size} known properties`
        : `unexpected: [${cleanVocab.map((f) => f.code + ' ' + f.message.slice(0, 60)).join(' | ')}]`,
    )

    // The positive control: plant exactly the two defects this check exists for.
    const plantedDir = path.join(vocabDir, 'vocabplanted')
    await scaffoldMod({ modDir: vocabDir, name: 'vocabplanted', tags: ['Gameplay'], systems: ['localization', 'events', 'decisions'] })
    await put(
      path.join(plantedDir, 'events', 'vocabplanted_events.txt'),
      `namespace = vocabplanted\n\nvocabplanted.0001 = {\n${TAB}type = character_event\n${TAB}theme = realm_management\n${TAB}is_triggered_only = yes\n\n${TAB}option = {\n${TAB}${TAB}name = "vocabplanted_greeting"\n${TAB}}\n}\n`,
    )
    const plantedVocab = await checkVanillaKeys(
      { name: 'vocabplanted', folderPath: plantedDir, modFilePath: null },
      syntheticGameRoot,
    )
    const codes = plantedVocab.map((f) => f.code).sort()
    check(
      'checkVanillaKeys: names EXACTLY the never-used property and the undefined theme, nothing else',
      codes.length === 2
        && codes.includes(CODES.VANILLA_KEY_UNKNOWN)
        && codes.includes(CODES.EVENT_THEME_UNKNOWN),
      `codes: [${codes.join(', ')}] — extra codes mean the depth cut is wrong in the shallow direction`,
    )
    check(
      'checkVanillaKeys: the messages state the measured boundary, never an engine verdict',
      plantedVocab.every((f) => !/\brejects?\b|\binvalid\b/i.test(f.message)),
      'no message claims the engine rejects anything — "vanilla never uses it" is the whole claim',
    )
  }
}

/* ------------------------------------------------------------------ *
 * The launcher database is CHOSEN, not assumed
 * ------------------------------------------------------------------ */

/*
 * Measured on this machine before any of this existed: `launcher-v2.sqlite` held **0** mods while
 * `launcher-v2_openbeta.sqlite` — the file the launcher is actually writing — held **7**, and the
 * tool reported "no registered mods" plus "no launcher/disk disagreement" while the game's own log
 * listed all seven. The choice is therefore asserted here rather than left to a hardcoded filename.
 */
{
  const candidate = (file, modCount, mtimeMs, extra = {}) => ({
    file,
    path: 'X:\\' + file,
    bytes: 4096,
    mtimeMs,
    modCount,
    playsetModCount: modCount,
    playsetIsActive: modCount > 0,
    unreadable: null,
    ...extra,
  })
  const emptyButNewer = candidate('launcher-v2.sqlite', 0, 3000, { playsetIsActive: null })
  const fullAndNewest = candidate('launcher-v2_openbeta.sqlite', 7, 2000)
  const backup = candidate('launcher-v2_openbeta-backup.sqlite', 3, 1000)
  const chosen = selectLauncherCandidate([emptyButNewer, fullAndNewest, backup])
  check(
    'selectLauncherCandidate: a database WITH registered mods wins over a newer empty one',
    chosen.chosen !== null && chosen.chosen.file === 'launcher-v2_openbeta.sqlite',
    `chose ${chosen.chosen?.file} — the bug this guards against read ${emptyButNewer.file} (0 mods) and reported "no mods registered"`,
  )
  check(
    'selectLauncherCandidate: two databases with mods are ranked by mtime, and the loser says so',
    chosen.others.find((o) => o.file === 'launcher-v2_openbeta-backup.sqlite')?.reason === 'older than the chosen database',
    chosen.others.map((o) => `${o.file}=${o.reason}`).join('; '),
  )
  check(
    'selectLauncherCandidate: the passed-over databases are reported WITH a reason',
    chosen.others.length === 2
      && chosen.others.every((o) => typeof o.reason === 'string' && o.reason.length > 0)
      && chosen.others.find((o) => o.file === 'launcher-v2.sqlite')?.reason === 'no registered mods',
    chosen.others.map((o) => `${o.file}=${o.reason}`).join('; '),
  )
  check(
    'selectLauncherCandidate: the choice does not depend on input order',
    selectLauncherCandidate([backup, emptyButNewer, fullAndNewest]).chosen?.file === chosen.chosen?.file,
    'same winner from a permuted list',
  )
  /*
   * The comparator used to be a chain of pairwise booleans (`if (a.hasMods !== b.hasMods) …`) with
   * mtime as one of the steps, which is not guaranteed to be a total order — and `Array.prototype.sort`
   * made by such a comparator can land on different winners for different input orderings. The
   * replacement compares a rank RECORD as a whole. This fixture is the real shape: the file the
   * launcher is actually writing holds the most mods (a `-backup` is thinner by construction) while
   * the stable name is empty and newest. The assertion demands one winner across all six orderings
   * AND that the winner is the rich database — a "newest wins" rule would answer with the empty file.
   */
  const adversarial = [
    candidate('launcher-v2.sqlite', 0, 3000, { playsetIsActive: null }),
    candidate('launcher-v2_openbeta.sqlite', 7, 2000),
    candidate('launcher-v2_openbeta-backup.sqlite', 3, 1000),
  ]
  const winners = new Set()
  for (const permutation of [
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ]) {
    winners.add(selectLauncherCandidate(permutation.map((i) => adversarial[i])).chosen?.file)
  }
  check(
    'selectLauncherCandidate: a total order — all six input orderings agree, and the database with the most mods wins',
    winners.size === 1 && [...winners][0] === 'launcher-v2_openbeta.sqlite',
    `winners: ${[...winners].join(', ')} — a "newest file wins" comparator picks the ${adversarial[0].file} here, which is the whole defect`,
  )
  const allEmpty = selectLauncherCandidate([
    candidate('launcher-v2.sqlite', 0, 3000, { playsetIsActive: null }),
    candidate('launcher-v2_openbeta.sqlite', 0, 5000, { playsetIsActive: null }),
  ])
  check(
    'selectLauncherCandidate: with every database empty, the newest still wins',
    allEmpty.chosen?.file === 'launcher-v2_openbeta.sqlite',
    `chose ${allEmpty.chosen?.file}`,
  )
  const unreadable = selectLauncherCandidate([
    candidate('launcher-v2_openbeta.sqlite', 0, 9000, { unreadable: 'file is not a database' }),
    candidate('launcher-v2.sqlite', 0, 1000, { playsetIsActive: null }),
  ])
  check(
    'selectLauncherCandidate: an unreadable database loses even when it is newest, and says why',
    unreadable.chosen?.file === 'launcher-v2.sqlite'
      && unreadable.others[0]?.reason?.startsWith('unreadable:'),
    `chose ${unreadable.chosen?.file}; reason ${unreadable.others[0]?.reason}`,
  )
  check(
    'selectLauncherCandidate: no candidates is a state, not a throw',
    selectLauncherCandidate([]).chosen === null && selectLauncherCandidate([]).others.length === 0,
    'empty input -> { chosen: null, others: [] }',
  )

  const launcherFixtureDir = path.join(root, 'launcher-fixture')
  await put(path.join(launcherFixtureDir, 'mod', 'a.mod'), 'name="a"\n')
  await put(path.join(launcherFixtureDir, 'mod', 'b.mod'), 'name="b"\n')
  await put(path.join(launcherFixtureDir, 'mod', 'notes.txt'), 'not a mod\n')
  const listed = await listLauncherModFiles(launcherFixtureDir)
  check(
    'listLauncherModFiles: only .mod names come back, sorted',
    listed.length === 2 && listed[0] === 'a.mod' && listed[1] === 'b.mod',
    `got [${listed.join(', ')}]`,
  )
  check(
    'listLauncherModFiles: a directory that does not exist returns [] rather than throwing',
    (await listLauncherModFiles(path.join(root, 'no-such-launcher-dir'))).length === 0,
    '[]',
  )

  const available = { available: true, mods: [{ gameRegistryId: 'mod/a.mod', displayName: 'a' }] }
  const unregistered = compareLauncherToDiskFiles(available, ['a.mod', 'b.mod'], path.join(launcherFixtureDir, 'mod'))
  check(
    'launcher-mod-unregistered: a .mod the registry does not name IS reported, with the on-disk one left alone',
    unregistered.length === 1
      && unregistered[0].code === 'launcher-mod-unregistered'
      && unregistered[0].severity === 'warn'
      && unregistered[0].file.endsWith('b.mod'),
    `got [${unregistered.map((f) => f.file.split(path.sep).pop()).join(', ')}]`,
  )
  check(
    'launcher-mod-unregistered: registered-but-differently-cased names still count as registered',
    compareLauncherToDiskFiles({ available: true, mods: [{ gameRegistryId: 'mod/A.MOD' }] }, ['a.mod'], '').length === 0,
    'case-insensitive matching, because Windows filenames are',
  )
  check(
    'launcher-mod-unregistered: an unavailable database reports NOTHING (absence must not look like a defect)',
    compareLauncherToDiskFiles({ available: false, mods: [] }, ['a.mod', 'b.mod'], '').length === 0,
    'the contract falsify.mjs:1025 already described is now actually exercised',
  )
  check(
    'launcher-mod-unregistered: a registry with no gameRegistryId columns does not condemn every file',
    compareLauncherToDiskFiles({ available: true, mods: [{ displayName: 'x' }, {}] }, ['a.mod'], '').length === 1,
    'one file, one finding: a missing id is not a match for anything',
  )
  check(
    'launcher-mod-unregistered: a non-.mod file name is never reported',
    compareLauncherToDiskFiles(available, ['notes.txt'], '').length === 0,
    'only .mod names are candidates',
  )
}

/* ------------------------------------------------------------------ *
 * The runtime evidence plane: run identity, and shell lines with continuations
 * ------------------------------------------------------------------ */

/*
 * Measured on a modded run: `error.log` held 1780 E-level lines but only 43 distinct MESSAGES,
 * because 1562 of them were the same shell line with their real content on the following,
 * non-timestamped lines. A deduplication key of "the message" collapsed 1621 real errors into 2 and
 * printed the 43 as if it were an error count. These fixtures pin both halves of the fix.
 */
{
  const logsFixture = path.join(root, 'logs-fixture')
  const SHELL = 'Script system error! (while building tooltip/description)'
  await put(path.join(logsFixture, 'error.log'), [
    '[23:22:47][E][jomini_script_system.cpp:303]: ' + SHELL,
    "  Error: Undefined event target 'liege'",
    '  Script location: file: common/script_values/00_court_position_values.txt line: 779',
    '[23:22:48][E][jomini_script_system.cpp:303]: ' + SHELL,
    '  Error: Undefined event target liege',
    '  Script location: file: common/script_values/00_court_position_values.txt line: 780',
    '[23:22:49][E][jomini_script_system.cpp:303]: ' + SHELL,
    '  Error: Undefined event target leige',
    '  Script location: file: common/script_values/00_court_position_values.txt line: 781',
    '[23:22:50][E][jomini_script_system.cpp:303]: ' + SHELL,
    "  Error: Undefined event target 'liege'",
    '  Script location: file: common/script_values/00_court_position_values.txt line: 779',
    '',
  ].join('\n'))
  await put(path.join(logsFixture, 'code_revisions.log'), '[23:16:57][I][jomini_game_setup.cpp:352]: game_hash_long: 6b540d23dbb0ae5f6a2ccc155338feabbaf64bbc\n')
  await put(path.join(logsFixture, 'system.log'), '[23:16:57][D][game_setup.cpp:82]: Exe Git Version: q2-26/fix/dlc_fix : 6b540d23d\n')
  const evidence = await readRuntimeEvidence(logsFixture)
  check(
    'shell lines: three distinct faults behind one shell are three messages, not one',
    evidence.distinctErrors.length === 3,
    `got ${evidence.distinctErrors.length}`,
  )
  check(
    'shell lines: a repeated shell+continuation pair stays ONE message with count 2',
    evidence.distinctErrors.some((e) => e.count === 2),
    evidence.distinctErrors.map((e) => e.count).join(','),
  )
  check(
    'shell lines: the continuation text is part of the entry, not lost',
    evidence.distinctErrors.every((e) => e.continuation.includes('Script location:')),
    'each entry carries its `Script location:` line',
  )
  check(
    'shell lines: raw lines, distinct shells and the second collapse number are all reported',
    evidence.rawELines === 4
      && evidence.distinctErrors.length === 3
      && evidence.suppressedShellErrors === evidence.rawELines - evidence.distinctErrors.reduce((n, e) => n + e.count, 0),
    `raw ${evidence.rawELines}, distinct ${evidence.distinctErrors.length}, suppressed ${evidence.suppressedShellErrors}`,
  )
  check(
    'run identity: the earliest timestamp dates the run, even when it is not the first file read',
    evidence.run?.startedAt === '23:16:57',
    `startedAt=${evidence.run?.startedAt}`,
  )
  check(
    'run identity: the install version and game hash are read from the startup lines',
    evidence.run?.gameHash?.startsWith('6b540d23') && evidence.run?.exeVersion?.startsWith('q2-26'),
    `${evidence.run?.gameHash} / ${evidence.run?.exeVersion}`,
  )
  check(
    'an unreadable logs directory reports unavailable AND still exposes the new fields',
    (await readRuntimeEvidence(path.join(root, 'no-such-logs'))).available === false,
    '`available:false` shape preserved',
  )
  const older = describeLogRun([{ name: 'a.log', bytes: 3, text: '[23:00:00][D][x:1]: y\n', bySeverity: {} }])
  check(
    'describeLogRun: a single file still yields a start time',
    older.startedAt === '23:00:00' && older.gameHash === null,
    JSON.stringify(older),
  )
}

/* ------------------------------------------------------------------ *
 * Tool descriptions — the drift that nothing used to see
 * ------------------------------------------------------------------ */

/*
 * `apply()` is never called by this suite, so when the four descriptions were inline literals not one
 * of them could be asserted. Two drifted as a result: the evidence tool promised a reachability
 * signal while its own output said the file it needs is never created, and the checker called the
 * `path=` format unverified a year after the wiki settled it. The descriptions now live in
 * TOOLS_META so they can be pinned here.
 *
 * These assertions deliberately encode the BINDING conditions, not the exact prose, so honest
 * re-wording stays possible while dropping a qualifier does not.
 */
{
  const names = Object.keys(TOOLS_META).sort()
  check(
    'tool table: exactly the four tools are described, and none of them is empty',
    names.length === 4
      && names.join(',') === 'ck3_mod_evidence,ck3_mod_init,ck3_mod_status,ck3_modcheck'
      && names.every((n) => TOOLS_META[n].name === n && TOOLS_META[n].description.trim().length > 80),
    `names: ${names.join(', ')}; the registration sites read these fields`,
  )
  const evidenceText = TOOLS_META.ck3_mod_evidence.description
  check(
    'ck3_mod_evidence description: event_log.csv is never presented as present without its unavailability',
    !/event_log\.csv/.test(evidenceText)
      || (/(读不到|缺能力|永不写|never|not created)/.test(evidenceText) && /(若存在|只在|当且仅当|only when|if.*write)/.test(evidenceText)),
    'a description may raise the capability only alongside the condition under which it exists',
  )
  check(
    'ck3_mod_evidence description: the per-run scope of the logs is stated',
    /每次运行|每次启动|per run|overwritten/.test(evidenceText),
    'the logs are rewritten by each launch, so a report must date itself',
  )
  check(
    'ck3_modcheck description: the path= claim is about the launcher, not an unverified format',
    !/format[^.]*unverified|相对 vs 绝对|relative vs absolute is unverified/i.test(TOOLS_META.ck3_modcheck.description)
      && /launcher/i.test(TOOLS_META.ck3_modcheck.description),
    'the three spellings are documented; what cannot be claimed is that the launcher accepted yours',
  )
  const codes = Object.values(CODES)
  check(
    'CODES: every code has a severity, and the table is the size the plugin claims',
    codes.every((code) => SEVERITY[code] === 'error' || SEVERITY[code] === 'warn') && codes.length === 39,
    `codes: ${codes.length} — 38 from the original brief plus launcher-mod-unregistered; tag-unknown was removed`,
  )
  check(
    'CODES: no duplicate code strings (a copy-paste would silently shadow a check)',
    new Set(codes).size === codes.length,
    `${new Set(codes).size} unique of ${codes.length}`,
  )
  const retired = 'tag-' + 'unknown'
  check(
    'retired codes: tag-unknown is not produced by any check, so it cannot appear in a report',
    !codes.includes(retired) && !Object.keys(SEVERITY).includes(retired),
    'the tag vocabulary check was retired by measurement; nothing may resurrect it silently',
  )
  const caveat = closingCaveat()
  check(
    'the report closing caveat: the path= claim is about the launcher, not an unverified format',
    !/unverified here/i.test(caveat) && /launcher/i.test(caveat) && /loads the mod/i.test(caveat),
    'the same stale claim lived in two places — the tool description and this closing line',
  )
  const zero = renderReport({ title: 'x', modsScanned: 0, baseDir: '.', findings: [], notes: ['nothing here'] })
  const one = renderReport({ title: 'x', modsScanned: 1, baseDir: '.', findings: [], notes: [] })
  check(
    'renderReport: a run that examined nothing does not print the pass sentence a clean run prints',
    /no check ran/i.test(zero) && !/no check ran/i.test(one) && /every check that ran passed/i.test(one),
    'measured: a missing modDir printed "No findings: every check that ran passed" over an empty directory',
  )
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

try {
  await main()
} catch (error) {
  failures += 1
  results.push({ label: 'harness', ok: false, detail: `threw: ${error?.stack ?? error}` })
}

const width = Math.max(...results.map((r) => r.label.length))
for (const r of results) {
  const mark = r.ok ? 'ok  ' : 'FAIL'
  console.log(`${mark} ${r.label.padEnd(width)}  ${r.detail}`)
}
console.log('')
console.log(`${results.length - failures}/${results.length} assertions passed`)
console.log(`fixtures: ${root}`)

await rm(root, { recursive: true, force: true })

if (failures > 0) {
  console.log('')
  console.log(`FALSIFICATION FAILED: ${failures} assertion${failures === 1 ? '' : 's'} did not hold`)
  process.exit(1)
}
console.log('FALSIFICATION PASSED')

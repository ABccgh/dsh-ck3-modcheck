/**
 * dsh-ck3-modcheck — validate Crusader Kings III mods on disk against rules taken from the
 * vanilla game installation and the CK3 Wiki's `Mod structure` page.
 *
 * ## Why this file carries no BARE imports
 *
 * The constraint is on **bare specifiers only** — `@deepseek-ai/dsh-tools`, any package name.
 * Relative imports among this plugin's own files are fine and are used below (`./rules.mjs`).
 * The sanctioned install (`dsh plugin --profile <profile> add <path>`) links this package into
 * a profile's `node_modules`, and Node resolves a symlinked module's own bare specifiers from
 * the link's **real path** — `$DSH_HOME/plugins/dsh-ck3-modcheck`, which has no `node_modules`
 * above it. Measured on the sibling plugin `dsh-ima-kb`, the identical shape fails with
 * `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'`, so a bare import here
 * could not resolve. The two helpers this file needs from `@deepseek-ai/dsh-tools` — the
 * parameter-spec → JSON-Schema compiler and the `defineTool` wrapper — are therefore
 * implemented locally against the pattern the working plugin `dsh-ima-kb` established.
 *
 * ## Plane
 *
 * A HOST-plane row, one instance per process: the CK3 install and the mod directory are
 * machine-level facts shared by every session. It publishes **no** Cordis service — no
 * `provide()`, no service name to collide with, no realm — and registers **four** tools into
 * `ctx.tools` (`ck3_modcheck`, `ck3_mod_init`, `ck3_mod_status`, `ck3_mod_evidence`; the names and
 * descriptions live in {@link TOOLS_META} so the test suite can assert them). Two levels up are
 * anything that varies per session (a persona, a prompt section), and none of that belongs here.
 *
 * ## What it can and cannot establish
 *
 * It establishes **layout and encoding facts about bytes on disk**: the presence and naming of
 * the two `.mod` files, the existence of the path a `.mod` file points at, ASCII-safety of that
 * path, the UTF-8 BOM and `l_english:` header of each localization file, the shape of each
 * localization entry, brace balance of script files, and whether a mod's `common\` subdirectories
 * have vanilla counterparts.
 *
 * It cannot establish that the game **loads** the mod, and it cannot judge the *format* of the
 * `.mod` file's `path=` value (relative or absolute is unverified on this machine, and there is
 * no sample mod here to measure). Every report this plugin prints says so in its closing lines,
 * and no finding ever claims a path format is wrong.
 *
 * @module dsh-ck3-modcheck
 */

import path from 'node:path'
import { stat } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  CODES,
  LANGUAGE_DIRS,
  SEVERITY,
  collectFiles,
  compareLauncherToDisk,
  compareLauncherToDiskFiles,
  decodeText,
  discoverMods,
  firstNonAscii,
  hasBom,
  listLauncherModFiles,
  listNames,
  planFixes,
  readBytes,
  readLauncherState,
  readRuntimeEvidence,
  resolveModTarget,
  scaffoldMod,
  validateMod,
  writeFileBytes,
} from './rules.mjs'

/** Cordis plugin name, for loader diagnostics. */
export const name = 'ck3-modcheck'

/**
 * The four tools this row registers, with the descriptions the model reads.
 *
 * **Why the names and descriptions live in a table rather than inline at the registration site.**
 * `test/falsify.mjs` cannot see an inline literal: `apply()` is not called by the suite, and a
 * description that promises something the tool no longer does therefore drifts with nothing to catch
 * it. That is not hypothetical here — `ck3_mod_evidence`'s description promised an event-reachability
 * signal while the tool's own output said the file it needs is never created, and `ck3_modcheck`'s
 * description called the `path=` format unverified a year after the wiki settled it. Both texts are
 * now asserted, which is only possible because they are reachable from outside `apply()`.
 */
export const TOOLS_META = Object.freeze({
  ck3_modcheck: {
    name: 'ck3_modcheck',
    description:
      'Validate Crusader Kings III mods on disk against rules taken from the vanilla game installation and the CK3 '
      + 'Wiki "Mod structure" page: both .mod files and their naming, the existence and ASCII-safety of the .mod '
      + 'file\'s path target, whether that target is this mod\'s own folder, the UTF-8 BOM and `l_english:` header of '
      + 'every localization .yml, localization entry shape, brace balance of script .txt files, and vanilla '
      + 'counterparts for a mod\'s common\\ subdirectories. '
      + 'Read-only unless fix=true. '
      + 'It does NOT establish that the launcher ACCEPTED the `path=` value (that is the launcher\'s behaviour, not a '
      + 'property of the file — `ck3_mod_status` reads the launcher\'s own verdict) and it does NOT establish that the '
      + 'game actually loads the mod.',
  },
  ck3_mod_init: {
    name: 'ck3_mod_init',
    description:
      '从零生成一个最小但**可加载**的 CK3 mod 骨架，并立刻用 ck3_modcheck 自证其**静态**结构。'
      + '生成两个 .mod 文件（并排的 (name).mod ＋ 文件夹内的 descriptor.mod，后者不含 path 行，'
      + '这是 wiki 明写的规则）、带 UTF-8 BOM 的 localization\\english\\<name>_l_english.yml、'
      + '以及按 systems 选择的 events／decisions 样例（事件文件自带 namespace 且 id 使用它）。'
      + '自证只覆盖磁盘上的文件形状，**不含**「启动器认不认」与「游戏会不会加载」——那两步要 ck3_mod_status 与游戏本体。'
      + '默认**绝不覆盖**已存在的文件——同名文件会被拒绝并列出，除非显式传 ifExists="overwrite"。',
  },
  ck3_mod_evidence: {
    name: 'ck3_mod_evidence',
    description:
      '读取 CK3 的运行时日志（logs\\error.log、database_conflicts.log 等），把静态检查**结构上给不了**的那一面报出来：'
      + '可疑的错误、以及「引用但从不触发的事件」——**后者只在引擎真的写出 `event_log.csv` 时才可能有**，'
      + '而本机 1.19.0.6 实测永不写该文件（`event_queue` 跑过、不写文件），'
      + '所以在本机上这一项永远报「读不到（缺能力，不是通过）」，工具绝不会把它说成「没问题」。'
      + '日志行格式为 `[HH:MM:SS][级别][源:行]: 消息`，`Script system error!` 这类外壳会与其续行合并成一条。'
      + 'ⓐ 日志是**每次运行**的（下次启动即被重写），报告会标出本次运行的起点；'
      + 'ⓑ 严格区分三态：目录不存在（游戏从未启动）／存在但全为 0 字节（尚未 flush，**不等于没有错误**）／'
      + '有内容（**也不等于有问题**——实测无 mod 启动时 setup.log 就有 512 条原版自身的 W 级告警）。'
      + '因此本工具只统计与报告，只有事件可达性才产生 finding。',
  },
  ck3_mod_status: {
    name: 'ck3_mod_status',
    description:
      '读取启动器的 playset 数据库（launcher-v2*.sqlite，只读），报告启动器眼中的模组状态：'
      + '每个已注册模组的名称／版本／requiredVersion／status／metadataStatus，以及当前 playset 里'
      + '每个模组的 enabled 与 position（position 就是加载顺序——wiki：playset 里靠下的覆盖靠上的）。'
      + '**读哪个文件是探测出来的，不是写死的**：本机同目录下 `launcher-v2.sqlite` 是空的（0 个 mod），'
      + '真正在用的一份带 7 个 mod，所以工具按「有 mod 记录且最新」选择并打印全部候选与判定。'
      + '并与磁盘交叉判定：启动器登记了但文件已不在的「死条目」、启动器自己判定为坏的模组、'
      + '以及**在启动器 mod 目录里但注册表没有的 .mod**（文件在盘上不等于启动器会认它）。'
      + '数据库不存在（启动器从未运行过）时明确报告原因，不抛错。',
  },
})

/**
 * The host services this row consumes: the filesystem seam, and the host tool registry it
 * registers one tool into. `tools` is not optional bookkeeping — the context proxy reads a
 * service only when it was declared here (`ReflectService.handler` throws
 * `cannot get property "tools" without inject` otherwise), so omitting it makes the whole
 * plugin tree fail to load, not just this row.
 */
export const inject = ['fs', 'tools']

/**
 * Defaults for every config field.
 *
 * `gameRoot` and `modDir` are the values measured on this machine. `modDir` intentionally does
 * **not** sit under `Documents`: the Windows account name here is `曦曦`, and the CK3 Wiki
 * `Mod structure` page states verbatim *"Directory cannot include non English characters. If
 * your Windows account name have such characters you must use a directory outside your
 * Documents folder."* The default is therefore an ASCII-only path on D:.
 */
export const DEFAULTS = Object.freeze({
  gameRoot: 'D:\\Program Files (x86)\\Steam\\steamapps\\common\\Crusader Kings III',
  modDir: 'D:\\CK3Mods',
  strict: true,
  /*
   * The launcher's user directory — where `launcher-v2.sqlite` lives. This one DOES sit under
   * `Documents`, unlike `modDir`, and that is not a contradiction: the non-ASCII restriction the
   * wiki states applies to a **mod's own directory**, which the game must resolve while loading.
   * This path is read by the *launcher's tooling* and by this plugin through Node, neither of which
   * has that restriction, and it is the launcher's fixed location — moving it is not an option.
   * `ck3_mod_status` reads it strictly read-only and reports plainly when it is absent.
   */
  launcherDir: 'C:\\Users\\曦曦\\Documents\\Paradox Interactive\\Crusader Kings III',
})

/** The config fields the schema knows; anything else is rejected at load. */
const KNOWN_FIELDS = Object.keys(DEFAULTS)

/**
 * Config schema, hand-written as a Standard Schema object.
 *
 * Cordis asks a plugin's `Config` for exactly one thing — `runtime.Config['~standard']
 * .validate(config)`, synchronously — so this satisfies the loader without importing a schema
 * library, exactly as the sanctioned `dsh-ima-kb` plugin does. A bad field is still reported at
 * load time as `invalid config: … (at <field>)`.
 *
 * ⚠️ **One consequence worth knowing before you trust a green preflight:** this repo's static
 * `bin/preflight.mjs` only reads a plugin's exported `Config` when `typeof Schema ===
 * 'function'` (`:178`), so a plain-object schema like this one is reported as
 * `skip <id> (exports no usable Config schema)` and that row's config is **not** validated
 * statically at all. The loader does validate it at mount. `test/falsify.mjs` asserts the four
 * behaviours below directly, because nothing else does.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-ck3-modcheck',
    /**
     * Validate and default one config object.
     * @param raw - the row's config, as the loader read it from YAML.
     * @returns `{ value }` with defaults applied, or `{ issues }` naming each bad field.
     */
    validate(raw) {
      const issues = []
      const input = raw === undefined || raw === null ? {} : raw
      if (typeof input !== 'object' || Array.isArray(input)) {
        return { issues: [{ message: 'config must be an object' }] }
      }
      const value = { ...DEFAULTS }
      for (const field of ['gameRoot', 'modDir', 'launcherDir']) {
        const given = input[field]
        if (given === undefined) continue
        if (typeof given !== 'string' || given.trim() === '') {
          issues.push({ message: `${field} expected a non-empty string path but got ${JSON.stringify(given)}`, path: [field] })
          continue
        }
        value[field] = given
      }
      if (input.strict !== undefined) {
        if (typeof input.strict !== 'boolean') {
          issues.push({ message: `strict expected a boolean but got ${JSON.stringify(input.strict)}`, path: ['strict'] })
        } else value.strict = input.strict
      }
      for (const key of Object.keys(input)) {
        if (!KNOWN_FIELDS.includes(key)) issues.push({ message: `unknown config field "${key}"`, path: [key] })
      }
      return issues.length > 0 ? { issues } : { value }
    },
  },
}

/* ------------------------------------------------------------------ *
 * The local defineTool — the two things the registry actually consumes
 * ------------------------------------------------------------------ */

/**
 * Compile one declared parameter into JSON Schema.
 * @param name - the parameter name, for error messages.
 * @param spec - the declared spec.
 * @returns a raw JSON Schema node.
 */
function compileParameter(name, spec) {
  if (spec === null || typeof spec !== 'object') {
    throw new Error(`ck3-modcheck: parameter "${name}" must be a schema spec object`)
  }
  const node = { type: spec.type }
  if (spec.description !== undefined) node.description = spec.description
  if (spec.type === 'array') {
    if (spec.items === undefined) throw new Error(`ck3-modcheck: parameter "${name}" of type array requires items`)
    node.items = compileParameter(`${name}[]`, spec.items)
  }
  if (spec.type === 'object') {
    if (spec.properties === undefined) throw new Error(`ck3-modcheck: parameter "${name}" of type object requires properties`)
    const properties = {}
    const required = []
    for (const [key, child] of Object.entries(spec.properties)) {
      const { schema, isRequired } = compileProperty(key, child)
      properties[key] = schema
      if (isRequired) required.push(key)
    }
    node.properties = properties
    if (required.length > 0) node.required = required
  }
  return node
}

/**
 * Compile one property entry, reporting whether it is required.
 * @param key - the property name.
 * @param spec - the declared spec.
 * @returns the schema node and the required flag.
 */
function compileProperty(key, spec) {
  return { schema: compileParameter(key, spec), isRequired: spec?.required === true }
}

/**
 * Compile a parameter-spec map into an object-rooted JSON Schema.
 *
 * A tool definition without this registers and then shows the model **no parameters at all** —
 * the silent failure this function exists to prevent.
 *
 * @param spec - the tool's `parameters`.
 * @returns the raw schema the registry stores and the model sees.
 */
export function parameterSchemaSpecToJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, child] of Object.entries(spec)) {
    const { schema, isRequired } = compileProperty(key, child)
    properties[key] = schema
    if (isRequired) required.push(key)
  }
  const schema = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  return schema
}

/**
 * Validate model-supplied arguments against a compiled parameter schema.
 *
 * The registry validates at dispatch; doing it here too means a bad call is reported as
 * `invalid arguments: …` rather than surfacing as an `undefined` deep inside a directory walk.
 *
 * @param schema - the compiled schema.
 * @param args - the candidate arguments.
 * @param pathSoFar - the path so far, for messages.
 * @returns path-qualified violations; empty means valid.
 */
function findViolations(schema, args, pathSoFar = '') {
  const violations = []
  const at = pathSoFar === '' ? '(root)' : pathSoFar
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return [`${at} expected an object`]
  }
  for (const key of schema.required ?? []) {
    if (args[key] === undefined) violations.push(`${at}.${key} is required`)
  }
  for (const [key, sub] of Object.entries(schema.properties ?? {})) {
    const value = args[key]
    if (value === undefined) continue
    violations.push(...findViolationsForValue(sub, value, `${pathSoFar}.${key}`))
  }
  return violations
}

/**
 * Validate one value against one schema node.
 * @param schema - the node.
 * @param value - the value.
 * @param pathSoFar - the path so far, for messages.
 * @returns violations.
 */
function findViolationsForValue(schema, value, pathSoFar) {
  switch (schema.type) {
    case 'string':
      return typeof value === 'string' ? [] : [`${pathSoFar} expected a string`]
    case 'integer':
      return Number.isInteger(value) ? [] : [`${pathSoFar} expected an integer`]
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? [] : [`${pathSoFar} expected a number`]
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${pathSoFar} expected a boolean`]
    case 'array':
      if (!Array.isArray(value)) return [`${pathSoFar} expected an array`]
      return value.flatMap((entry, index) => findViolationsForValue(schema.items, entry, `${pathSoFar}[${index}]`))
    default:
      return []
  }
}

/**
 * Define a registry-ready tool: parameters precompiled to JSON Schema, `output.schema` carried
 * through for `assertSupportedJsonSchema` at registration, and argument validation in `execute`.
 *
 * @param options - name, description, parameter spec, output projection, and execute.
 * @returns the definition to pass to `ctx.tools.register`.
 */
function defineTool(options) {
  const parameters = parameterSchemaSpecToJsonSchema(options.parameters)
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: { schema: options.output.schema, render: options.output.render },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.isConcurrencySafe === undefined ? {} : { isConcurrencySafe: options.isConcurrencySafe }),
    async execute(args, exec) {
      const violations = findViolations(parameters, args, '')
      if (violations.length > 0) throw new Error(`invalid arguments: ${violations.join('; ')}`)
      return options.execute(args, exec)
    },
  }
}

/** Render one text block. */
function text(value) {
  return [{ type: 'text', text: value }]
}

/* ------------------------------------------------------------------ *
 * Report rendering — exported, because the test asserts on it too
 * ------------------------------------------------------------------ */

/** Sort findings by severity, then path, then line. Errors first, as the brief requires. */
export function sortFindings(findings) {
  const rank = (finding) => (finding.severity === 'error' ? 0 : 1)
  return [...findings].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b)
    const fa = String(a.file)
    const fb = String(b.file)
    if (fa !== fb) return fa < fb ? -1 : 1
    return (a.line ?? 0) - (b.line ?? 0)
  })
}

/**
 * The line every report closes with. It states what the run did **not** verify, and it is
 * printed for a clean run too — a clean report is exactly when a reader is most likely to
 * over-read it.
 * @returns the caveat line.
 */
export function closingCaveat() {
  /*
   * This line used to call the `path=` FORMAT unverified. That was true of an earlier revision's
   * sources and is not true any more: the wiki's `Mod structure` Keys table gives three documented
   * spellings and names the base (the user folder). What remains genuinely outside this tool is
   * whether the launcher ACCEPTED whatever value was written — a property of the launcher, not of
   * the file.
   */
  return 'NOT VERIFIED: whether the launcher ACCEPTED the `path=` value (the three spellings are documented; the launcher\'s behaviour is not a property of the file — `ck3_mod_status` reads its verdict) and whether the game actually loads the mod — that requires running CK3 with the mod enabled, which this check does not do.'
}

/**
 * Render one report.
 *
 * @param options - `{ title, findings, modsScanned, fixResults, notes }`.
 * @returns the text the tool returns and shows the model.
 */
export function renderReport(options) {
  const findings = sortFindings(options.findings ?? [])
  const errors = findings.filter((f) => f.severity === 'error')
  const warnings = findings.filter((f) => f.severity === 'warn')
  const baseDir = options.baseDir
  const relative = (file) => {
    if (baseDir === undefined || baseDir === null) return String(file)
    const rel = path.relative(baseDir, String(file))
    return rel === '' ? '.' : rel.split(path.sep).join('\\')
  }

  const lines = []
  lines.push(`${options.title} — ${options.modsScanned} mod${options.modsScanned === 1 ? '' : 's'} validated`)
  lines.push(`errors: ${errors.length}   warnings: ${warnings.length}   total findings: ${findings.length}`)
  for (const note of options.notes ?? []) lines.push(note)
  lines.push('')

  if (findings.length === 0) {
    /*
     * A zero-finding verdict means two opposite things depending on whether anything was examined,
     * and the same sentence used to be printed for both. Measured: with `D:\CK3Mods` absent the tool
     * printed "0 mods validated" followed by "No findings: every check that ran passed. Nothing to
     * repair." — a report about *nothing* phrased like a pass. An empty result and an unread one must
     * not look the same, and here they did.
     */
    lines.push(options.modsScanned === 0
      ? 'No findings — but **no check ran** (0 mods validated). This is "nothing was examined", not "nothing is wrong": read the notes above for why nothing was found.'
      : 'No findings: every check that ran passed. Nothing to repair.')
  } else {
    lines.push('FINDINGS')
    for (const item of findings) {
      const where = `${relative(item.file)}${item.line > 0 ? `:${item.line}` : ''}`
      lines.push(`${item.severity} ${item.code} ${where} — ${item.message}`)
    }
    lines.push('')
    lines.push('SUGGEST')
    for (const item of findings) {
      const where = `${relative(item.file)}${item.line > 0 ? `:${item.line}` : ''}`
      lines.push(`${item.code} (${where}): ${item.suggestion}`)
    }
  }

  if (options.fixResults) {
    lines.push('')
    lines.push('FIX')
    if (options.fixResults.applied.length === 0) {
      lines.push('nothing was repaired')
    } else {
      for (const line of options.fixResults.applied) lines.push(`applied: ${line}`)
    }
    for (const skip of options.fixResults.skipped ?? []) lines.push(`not repaired — ${skip.code}: ${skip.reason}`)
  }

  lines.push('')
  lines.push(closingCaveat())
  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 * The fixer — the only place this plugin writes anything
 * ------------------------------------------------------------------ */

/**
 * Apply the unambiguously repairable subset, and nothing else.
 *
 * The three standing refusals, all enforced in `planFixes` in `rules.mjs`:
 * **never** rewrite a `.mod` file's `path`, **never** delete anything, and **never** touch
 * anything whose path contains a non-ASCII character. Only two repairs exist: prepend the UTF-8
 * BOM to a localization `.yml`, and create a missing `descriptor.mod` from the sibling `.mod`
 * file minus its `path` line.
 *
 * @param mods - the validated mods.
 * @param modDir - the directory holding them.
 * @returns `{ applied, skipped }` — human-readable lines.
 */
export async function applyFixes(mods, modDir) {
  const applied = []
  const skipped = []
  for (const mod of mods) {
    const plan = await planFixes(mod, mod.findings, modDir)
    for (const action of plan.actions) {
      try {
        await action.run()
        applied.push(`${action.describe}`)
      } catch (error) {
        skipped.push({ code: action.kind, reason: `failed to ${action.describe}: ${error instanceof Error ? error.message : String(error)}` })
      }
    }
    skipped.push(...plan.skipped)
  }
  const seen = new Set()
  return {
    applied: [...new Set(applied)],
    skipped: skipped.filter((entry) => {
      const key = `${entry.code}|${entry.reason}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }),
  }
}

/* ------------------------------------------------------------------ *
 * Mount
 * ------------------------------------------------------------------ */

/**
 * Mount the CK3 mod checker.
 *
 * @param ctx - plugin context carrying the host tool registry.
 * @param config - the validated configuration.
 */
export function apply(ctx, config) {
  ctx.tools.register(defineTool({
    name: TOOLS_META.ck3_modcheck.name,
    description: TOOLS_META.ck3_modcheck.description,
    parameters: {
      modPath: { type: 'string', description: '可选：mod 名称，或 mod 文件夹路径，或它的 .mod 文件路径。**省略时扫描 modDir 下的每一个 mod**；传值时注意它的语义是**这个路径本身就是一个 mod 文件夹**——传一个「装 mod 的目录」（例如 modDir 自身）会把目录当成一个 mod 去校验，那不是工具坏了，是参数含义不同。' },
      fix: { type: 'boolean', description: '可选，默认 false。仅当为 true 时修复可无歧义修复的项：给本地化 .yml 补 UTF-8 BOM、用同级 .mod 文件（去掉 path 行）生成缺失的 descriptor.mod。绝不改写 path、绝不删除任何文件、绝不触碰含非 ASCII 字符的路径。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    isConcurrencySafe: () => true,
    async execute(args) {
      const modDir = path.resolve(config.modDir)
      const notes = []
      const targets = []

      const resolved = resolveModTarget(modDir, args.modPath)
      if (resolved.folderName === null) {
        if (!await exists(modDir)) {
          return withReceipt(renderReport({
            title: `ck3_modcheck (modDir ${modDir})`,
            modsScanned: 0,
            baseDir: modDir,
            findings: [],
            notes: [
              `modDir does not exist: ${modDir} — there is nothing to scan.`,
              `Create it, or pass modPath, or set the modDir config field.`,
            ],
          }))
        }
        for (const target of await discoverMods(modDir)) targets.push(target)
        if (targets.length === 0) {
          return withReceipt(renderReport({
            title: `ck3_modcheck (modDir ${modDir})`,
            modsScanned: 0,
            baseDir: modDir,
            findings: [],
            notes: [`modDir exists and contains no mods: no subdirectory, and no .mod file.`],
          }))
        }
      } else {
        /*
         * A `modPath` that is not a folder is answered here rather than validated as a mod. Measured
         * before this guard existed: `ck3_modcheck README.md` (a file) reported "1 mod validated,
         * errors: 3" — `non-ascii-path` on the file itself, `descriptor-missing` on
         * `README.md\descriptor.mod` (a path that can never exist), and `mod-file-missing` for a
         * sibling `README.md.mod` — with suggestions telling the caller to create those files. Three
         * findings and three bad instructions from one input mistake. A file is not a mod, and the
         * cheapest way to not cry wolf is to say so.
         */
        let resolvedIsDirectory = false
        try {
          resolvedIsDirectory = (await stat(resolved.folderPath)).isDirectory()
        } catch { /* absent: handled by the message below, which is the same answer for both cases */ }
        if (!resolvedIsDirectory) {
          const looksLikeModFile = /\.mod$/i.test(String(args.modPath).trim())
          return [
            `# ck3_modcheck (modDir ${modDir})`,
            '',
            `modPath: ${String(args.modPath).trim()}`,
            '',
            looksLikeModFile
              ? `这里传入的是 **.mod 文件路径**，而本工具的 modPath 指的是**这个路径本身就是一个 mod 文件夹**。`
                + `去掉 \`.mod\` 后缀，或直接传 mod 名（例如 \`${resolved.folderName}\`），或省略 modPath 让工具扫描 modDir。`
              : `这个路径不存在，或它不是一个目录：${resolved.folderPath}`,
            '',
            '没有检查任何东西——这里报的**不是**「这个 mod 有问题」，而是**这个参数不是 mod**。',
            '另外注意 modPath 的语义：它指的是**这个路径本身就是一个 mod 文件夹**，不是「装 mod 的目录」；'
            + `传 \`${modDir}\` 这类目录会把目录本身当成 mod 去校验。`,
          ].join('\n')
        }
        const names = await listNames(modDir)
        const sibling = names.find((entry) => entry.toLowerCase().endsWith('.mod') && entry.slice(0, -4) === resolved.folderName)
        const saidModFile = args.modPath !== undefined && /\.mod$/i.test(String(args.modPath).trim())
        targets.push({
          name: resolved.folderName,
          folderPath: resolved.folderPath,
          modFilePath: sibling
            ? path.join(modDir, sibling)
            : (saidModFile && await exists(`${resolved.folderPath}.mod`) ? `${resolved.folderPath}.mod` : null),
        })
      }

      const mods = []
      for (const target of targets) {
        mods.push(await validateMod(target, { modDir, gameRoot: config.gameRoot, strict: config.strict }))
      }

      let findings = mods.flatMap((mod) => mod.findings.map((item) => ({ ...item, mod: mod.name })))

      let fixResults
      if (args.fix === true) {
        fixResults = await applyFixes(mods, modDir)
        if (fixResults.applied.length > 0) {
          // Only a run that actually changed something pays for a second pass; the post-repair
          // state is what a reader should act on, so it replaces the pre-repair finding list.
          const remaining = []
          for (let i = 0; i < targets.length; i += 1) {
            const after = await validateMod(targets[i], { modDir, gameRoot: config.gameRoot, strict: config.strict })
            remaining.push(...after.findings.map((item) => ({ ...item, mod: after.name })))
          }
          notes.push(`After repair the mods were re-validated; ${remaining.length} finding${remaining.length === 1 ? '' : 's'} remain (the FINDINGS block is the post-repair state).`)
          findings = remaining
        }
      }

      return withReceipt(renderReport({
        title: `ck3_modcheck (modDir ${modDir})`,
        modsScanned: mods.length,
        baseDir: modDir,
        findings,
        notes,
        fixResults,
      }))
    },
  }))

  ctx.tools.register(defineTool({
    name: TOOLS_META.ck3_mod_init.name,
    description: TOOLS_META.ck3_mod_init.description,
    parameters: {
      name: { type: 'string', required: true, description: 'mod 名（同时用作文件夹名、.mod 文件名与事件 namespace 基底）；必须是 ASCII。' },
      version: { type: 'string', description: '可选：mod 版本，默认 0.1.0。' },
      supportedVersion: { type: 'string', description: '可选：supported_version，默认 1.19.*（可用通配符）。' },
      tags: { type: 'array', description: '可选：tag 列表，默认 ["Gameplay"]，写成列表形式。', items: { type: 'string' } },
      systems: { type: 'array', description: '可选：要生成的系统样例，可含 localization／events／decisions，默认 ["localization"]。', items: { type: 'string' } },
      ifExists: { type: 'string', description: '可选：同名文件已存在时怎么办。"refuse"（默认，拒绝并保留原文件）或 "overwrite"。' },
      dryRun: { type: 'boolean', description: '可选，默认 false。true 时只列出将要创建的文件，不写任何东西。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    // It writes files: two concurrent calls naming the same mod would race on the same paths.
    isConcurrencySafe: () => false,
    async execute(args) {
      const modDir = path.resolve(config.modDir)
      const name = String(args.name ?? '').trim()
      if (name === '') return 'ck3_mod_init: `name` 不能为空。'
      // `firstNonAscii` answers `null` for a clean path, not `undefined` — a truthiness test is the
      // correct one here, and an `!== undefined` test silently rejected every valid ASCII name.
      const offender = firstNonAscii(name)
      if (offender !== null) {
        return `ck3_mod_init: name ${JSON.stringify(name)} 含非 ASCII 字符 ${JSON.stringify(offender.char)}。`
          + '目录名必须全 ASCII（CK3 Wiki `Mod structure` 原文：非英文目录会让启动器不认这个 mod），请换成 ASCII 名字。'
      }
      if (args.ifExists !== undefined && !['refuse', 'overwrite'].includes(args.ifExists)) {
        return `ck3_mod_init: ifExists 只能是 "refuse" 或 "overwrite"，收到 ${JSON.stringify(args.ifExists)}。`
      }
      const systemsArg = args.systems ?? ['localization']

      if (args.dryRun === true) {
        const wouldCreate = [path.join(modDir, `${name}.mod`), path.join(modDir, name, 'descriptor.mod')]
        if (systemsArg.includes('localization')) wouldCreate.push(path.join(modDir, name, 'localization', 'english', `${name}_l_english.yml`))
        if (systemsArg.includes('events')) wouldCreate.push(path.join(modDir, name, 'events', `${name}_events.txt`))
        if (systemsArg.includes('decisions')) wouldCreate.push(path.join(modDir, name, 'common', 'decisions', `${name}_decisions.txt`))
        const existing = []
        for (const p of wouldCreate) if (await exists(p)) existing.push(p)
        return withReceipt(['# ck3_mod_init (dryRun — 什么都没写)', '', `modDir: ${modDir}`, `name:   ${name}`, '',
          `将创建 ${wouldCreate.length} 个文件：`, ...wouldCreate.map((p) => `  ${p}`), '',
          existing.length === 0
            ? '没有同名文件冲突。'
            : `**${existing.length} 个同名文件已存在**，按 ifExists=${JSON.stringify(args.ifExists ?? 'refuse')} 会被拒绝（默认）或覆盖：\n${existing.map((p) => `  ${p}`).join('\n')}`,
        ].join('\n'))
      }

      const result = await scaffoldMod({
        modDir,
        name,
        version: args.version,
        supportedVersion: args.supportedVersion,
        tags: args.tags,
        systems: systemsArg,
        ifExists: args.ifExists,
      })

      // The self-证 step. A generator that produces something its own checker rejects is worse than
      // no generator, so running the validator on the result is part of the tool, not an extra.
      const verdict = await validateMod(
        { name, folderPath: result.folder, modFilePath: result.modFile },
        { modDir, gameRoot: config.gameRoot, strict: config.strict },
      )
      const lines = ['# ck3_mod_init', '', `modDir: ${modDir}`, `name:   ${name}`, '',
        `## 已创建（${result.created.length}）`, '', ...result.created.map((f) => `- ${f}`), '']
      if (result.refused.length > 0) {
        lines.push(`## 已拒绝（${result.refused.length}）—— 文件已存在，未改动`, '',
          ...result.refused.map((f) => `- ${f}`), '',
          '要覆盖它们，显式传 ifExists="overwrite"。', '')
      }
      lines.push('## 生成结果的自检（`ck3_modcheck`）', '',
        verdict.findings.length === 0
          ? '**0 findings** —— 生成的骨架通过全部检查。'
          : `**${verdict.findings.length} findings：**\n${verdict.findings.map((f) => `- ${f.severity.toUpperCase()} ${f.code}: ${f.message}`).join('\n')}`,
        '', '## 这次没有验证什么', '',
        '骨架通过静态检查**不等于**游戏会加载它，也不等于启动器认它。'
        + '下一步：把它放进 playset 并启动游戏；`ck3_mod_status` 能读出启动器是否登记了这个 mod。')
      return withReceipt(lines.join('\n'))
    },
  }))

  /* The runtime evidence plane — the only place a REACHABILITY failure is visible. */
  ctx.tools.register(defineTool({
    name: TOOLS_META.ck3_mod_evidence.name,
    description: TOOLS_META.ck3_mod_evidence.description,
    parameters: {
      logsDir: { type: 'string', description: '可选：日志目录；默认取 config 的 launcherDir 下的 logs。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    isConcurrencySafe: () => true,
    async execute(args) {
      const logsDir = args.logsDir ?? path.join(config.launcherDir, 'logs')
      const state = await readRuntimeEvidence(logsDir)
      const lines = ['# ck3_mod_evidence', '', `logs dir: ${logsDir}`]
      if (state.run !== null && state.run.startedAt !== null) {
        lines.push(`本次运行的日志起点: ${state.run.startedAt}`
          + `${state.run.exeVersion === null ? '' : `　版本: ${state.run.exeVersion}`}`
          + `${state.run.gameHash === null ? '' : `　hash: ${state.run.gameHash.slice(0, 12)}`}`,
        '',
        '⚠ **日志是「每次运行」的：下一次启动会把这些文件重写。** 所以这里读到的一切都属于**上面那一次运行**，'
        + '跨运行的数字不能相减；要看「我的 mod 有没有引入新错误」，必须在**同一次运行**里做加/不加的差分。'
        + '（唯一例外是 `console_history.txt`，它跨运行累积。）')
      }
      lines.push('')

      if (!state.available) {
        lines.push('## 不可用', '', state.reason, '',
          '这不是错误：游戏从未启动过就没有运行时证据可读。静态检查（`ck3_modcheck`）照常可用。')
        return withReceipt(lines.join('\n'))
      }

      const populated = state.files.filter((f) => f.bytes > 0)
      const empty = state.files.filter((f) => f.bytes === 0)

      if (!state.flushed) {
        lines.push('## 尚未 flush（**不是「没有错误」**）', '',
          `目录里有 ${state.files.length} 个日志文件，但**全部是 0 字节**。`,
          '这是游戏还在加载（或刚起、停在主菜单）时的正常状态：引擎启动时就把这些文件建好，边跑边写。',
          '',
          '**为什么会有这一段等待**：`log_settings_live.json` 与 `_release.json` 的顶层都是',
          '`flush_interval_seconds = 3`（实测），所以「文件已建、内容还没落盘」是一个**预期窗口**，',
          '不是一个异常读数。实测：启动后 45 秒仍是全 0，之后才陆续写入。',
          '',
          '一个空的 `error.log` 与一个「没有错误」的 `error.log` **在这套字节上无法区分**，',
          '所以本工具拒绝把前者报告成后者。等游戏完全进入一局之后再读。')
        return withReceipt(lines.join('\n'))
      }

      lines.push(`## 已写入的日志（${populated.length} / ${state.files.length} 个文件有内容）`, '',
        '| 文件 | 字节 | 行 | D | I | W | E | 未识别 |', '| --- | --- | --- | --- | --- | --- | --- | --- |')
      for (const f of [...populated].sort((a, b) => b.bytes - a.bytes)) {
        lines.push(`| ${f.name} | ${f.bytes} | ${f.lines} | ${f.bySeverity.D} | ${f.bySeverity.I} | ${f.bySeverity.W} | ${f.bySeverity.E} | ${f.bySeverity.unparsed} |`)
      }
      if (empty.length > 0) {
        lines.push('', `仍为 0 字节：${empty.map((f) => f.name).join('、')}`)
      }

      const totalE = populated.reduce((n, f) => n + f.bySeverity.E, 0)
      const totalW = populated.reduce((n, f) => n + f.bySeverity.W, 0)
      lines.push('', '## 怎么读这些数字（**有内容不等于有问题**）', '',
        `**外壳去重后不同的错误只有 ${state.distinctErrors.length} 条**，但按文件逐行统计是 ${totalE} 条 E、${totalW} 条 W。`,
        `两者不等有两个原因，**都不是 bug**：`,
        `1. 同一条消息会被引擎同时写进几个 sink（本机实测一条错误同时出现在 debug.log ＋ error.log ＋ game.log，虚高正好 3 倍）；`,
        `2. 引擎把一次脚本错误的**外壳**和**详情**写成多行——本机实测 ${state.rawELines} 条 E 行里，`
        + `同一句外壳（\`Script system error!\`）出现上千次，它们的真实内容在紧随的续行里。`
        + `本工具把外壳与其续行合成一条，所以 **${state.distinctErrors.length} 是消息种数，不是错误个数**：`
        + `它把 ${state.rawELines} 条 E 行折叠成了 ${state.distinctErrors.length} 个不同的错误。`,
        `结论：**看去重后的消息种类**，不要看逐文件求和；两者都不能单独当「错误总数」。`, '')
      if (state.distinctErrors.length > 0) {
        lines.push('按出现次数排序（`× N` 是它在本次运行里出现的行数）：', '')
        for (const e of state.distinctErrors.slice(0, 15)) {
          const detail = e.continuation === '' ? '' : `\n    ${e.continuation}`
          lines.push(`- \`${e.source}\`　**× ${e.count}**：${e.message.slice(0, 300)}${detail}`
            + `　*（出现在 ${e.files.join('、')}）*`)
        }
        if (state.distinctErrors.length > 15) lines.push(`- …还有 ${state.distinctErrors.length - 15} 条（按同一次运行、按次数排序）`)
        lines.push('', `只出现在少数 sink 里的消息往往更值得看：本机实测 error.log 独有的一批是 mod 脚本自身的语法错误`
          + `（例如 "Unknown trigger: limit" 与 "should be in utf8-bom encoding"），而绝大多数通用外壳行会同时出现在三个 sink 里。`)
        lines.push('')
      } else {
        lines.push('去重后没有任何 E 级行。', '')
      }
      lines.push('实测的两种机器状态（**各自标注是哪一次运行**，不要混用）：',
        '',
        '- **无 mod 的一次运行**（`enabled_mods: []`）：`setup.log` **512 条 W**，首行是原版自己的',
        '  `provincetemplate.cpp: Province 10186 has no pixels!`；`error.log` 只有 **2 条 E**，',
        '  例如 `landed_title_name_util.cpp:853: Failed to find any valid flavorization for title`。',
        '- **本机现在的状态已经不同**：7 个 workshop mod 在 `dlc_load.json` 里启用，同一次运行里',
        '  `setup.log` **519 条 W**、`error.log` **1780 条 E / 43 种**。所以 512/2 是**历史基线**，',
        '  不是当前读数——把它当成「正常值」会让一次 modded 运行看起来像灾难。',
        '',
        'wiki 也明说：*"the log will report errors even in an unmodded game"*。',
        '所以本工具**不**把「日志非空」当成缺陷。要归因只有一条正确做法：',
        '**在同一次运行内做加/不加你的 mod 的差分**——跨运行的数字不可相减（日志每次启动被重写）。')

      if (state.eventReport === null) {
        lines.push('', '## 事件可达性：读不到（**这是缺能力，不是通过**）', '',
          '没有 `event_log.csv`。**这个文件在本 build 里根本不会被创建**——不再是推测，已实测：',
          '',
          '- **命令确实跑通了**：当时 `console_history.txt` 里有 `event_queue` 一行，当次的 `debug.log` 里也留下了',
          '  `[20:16:11][D][console.cpp:1164]: Running console command: event_queue` 与',
          '  `Total items in queue: 2107`。（**注意这两件现场证据已被后续运行覆盖**：日志每次启动重写，',
          '  所以今天再读 `debug.log` 已经看不到它们；能复核的只剩 `console_history.txt`，它跨运行累积。）',
          '- **但它不创建 CSV**。`ck3.exe` 里 `event_queue` 的实现只含这些格式串：',
          '  `Total items in queue: %d` / `- Events: %d` / `- OnActions: %d` / `\\t%s\\t%d` /',
          '  `-- EVENTS --` / `-- ON_ACTIONS --`——**没有任何写文件的调用**。',
          '  实测它的输出全部落在 `debug.log`（`game.log` 里 0 条，符合二进制里那句',
          '  `Event queue data written to game log`）。',
          '- 那句 `Event debug info written to logs/event_log.csv` **确实存在**，但它与被执行的命令',
          '  **不是同一条代码路径**：它与 `logs/`、`logs/%s/%s.csv` 相邻，而这三者紧挨着',
          '  `help event_queue`，旁边就是 `See game.log for full help details.`——那是 **`help` 命令**',
          '  的日志重定向。**同偏移 ≠ 同功能**，早先「同属一个字符串池所以相关」的推论就是这样错的。',
          '- 即使不看二进制，实测也排除了它：**整个 `C:\\` 与 `D:\\` 递归搜 `event_log*` 零命中**。',
          '',
          '**所以能检查什么、不能检查什么，要分开说**：',
          '',
          '- **不能**从这条路径得到「引用但从不触发的事件」。`event_queue` 会把列表写进 `debug.log`，',
          '  但**写到第 29 条就断了**（表头自称 `- Events: 2063`，实际只落了 29 行；',
          '  `- OnActions: 44` 只落了 2 行）。29 条之外的缺失**完全没有信息量**，不是「从不触发」。',
          '- **能**得到的是那 29 条的**真实触发次数**（例如 `diarchy.0011` 693 次、',
          '  `councillor_spouse_background.0001` 584 次），这是引擎自己的计数，静态检查给不了。',
          '- 同族命令 **`event_counts`**（二进制里的帮助串是 `Print event debug counts`）尚未实测。',
          '  它可能给出完整计数表，值得一试；在跑过之前本工具**不假设它的行为**，也没有任何代码建立在它上面。',
          '',
          '把读不到读成「没有问题」是错的：本工具此刻对可达性**一无所知**。',
          '游戏内前提：`-debug_mode` 启动，并在控制台执行对应命令。')
      } else {
        lines.push('', `## 事件可达性（来自 ${state.eventReport.fileName}）`, '',
          `本次共 ${state.eventReport.rows.length} 个事件有记录，其中 **${state.eventReport.neverChecked.length}** 个被检查 0 次。`,
          `这属于**上面那一次运行**：换了运行之后要重读。`)
        for (const row of state.eventReport.neverChecked.slice(0, 20)) {
          lines.push(`- **${row.id}** 被检查 0 次 —— 没有任何东西调用它，它永远不会触发`)
        }
        if (state.eventReport.neverChecked.length > 20) lines.push(`- …还有 ${state.eventReport.neverChecked.length - 20} 个`)
      }

      lines.push('', '## 这次没有验证什么', '',
        `它读的是**上面那一次运行**（起点 ${state.run?.startedAt ?? '未知'}）留下的日志，而日志每次启动都被重写。`
        + '日志不含 mod 的加载成功与否，也不含「启动器是否接受」——那是 `ck3_mod_status`。'
        + '而且日志在无 mod 时也会有内容，所以「没看到自己的错误」不等于「自己的 mod 没问题」。')
      return withReceipt(lines.join('\n'))
    },
  }))

  /* The launcher plane. Deliberately a SECOND tool rather than more output on `ck3_modcheck`:
   * it answers a different question (what does the launcher think?) and it reads a different input
   * (the launcher's own database), so a caller who wants a static verdict should not pay for a
   * database read, and a caller who wants the launcher's verdict should not have to run the whole
   * file-check pass to get it. */
  ctx.tools.register(defineTool({
    name: TOOLS_META.ck3_mod_status.name,
    description: TOOLS_META.ck3_mod_status.description,
    parameters: {
      launcherDir: { type: 'string', description: '可选：Paradox 用户目录；默认取 config 的 launcherDir。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    isConcurrencySafe: () => true,
    async execute(args) {
      const launcherDir = args.launcherDir ?? config.launcherDir
      const state = await readLauncherState(launcherDir)
      const lines = [`# ck3_mod_status`, '', `launcher dir: ${launcherDir}`, `database:     ${state.databasePath}`]
      if (Array.isArray(state.databaseCandidates) && state.databaseCandidates.length > 0) {
        lines.push('', '| 库 | mods | playset | isActive | mtime | 判定 |', '| --- | --- | --- | --- | --- | --- |')
        for (const c of state.databaseCandidates) {
          const verdict = c.path === state.databasePath ? '**CHOSEN**' : `ignored: ${c.reason}`
          lines.push(`| ${c.file} | ${c.modCount} | ${c.playsetModCount}`
            + ` | ${c.playsetIsActive === null ? '—' : (c.playsetIsActive ? '1' : '0')}`
            + ` | ${c.mtimeMs === 0 ? '—' : new Date(c.mtimeMs).toISOString().slice(0, 16).replace('T', ' ')}`
            + ` | ${verdict} |`)
        }
        if (state.databaseCandidates.length > 1) {
          lines.push('', '⚠ 本目录有多个启动器数据库；工具从「有 mod 记录且最新」的那个读取。'
            + '若上面的结论与启动器界面不一致，先看这张表——读错一个文件会让「7 个 mod」显示成「0 个」。')
        }
      }
      lines.push('')
      if (!state.available) {
        lines.push('## 不可用', '', state.reason,
          '', '这不是错误：启动器还没写过数据库时，它对模组的看法本来就不存在。',
          '在此之前，"启动器认不认这个 mod" 只能由你自己在启动器里看。')
        return withReceipt(lines.join('\n'))
      }
      const launcherModDir = path.join(launcherDir, 'mod')
      const launcherModFiles = await listLauncherModFiles(launcherDir)
      lines.push(`## 启动器眼中的模组（${state.mods.length} 条）`, '')
      if (state.mods.length === 0) {
        /*
         * A false "0 mods" is the worst reading this tool can produce, because it reads as a verdict
         * about the author's mods when it is in fact a statement about this tool's input. Measured
         * here: the hardcoded database held 0 rows while `mod\` held seven `.mod` files, the game's
         * own log listed all seven, and two were mounted. So before "nothing is registered" is
         * printed as a fact, the launcher's own mod folder is checked.
         */
        lines.push(launcherModFiles.length > 0
          ? `（读到 0 条，但 ${launcherModDir} 下有 ${launcherModFiles.length} 个 .mod 文件：`
            + `**这更像读到了一个空的或陈旧的数据库，不是「没有模组」**。`
            + `若有多个候选库，检查上面的表。）`
          : '（没有任何已注册模组，启动器的 mod 目录里也没有 .mod 文件。）')
      }
      for (const mod of state.mods) {
        lines.push(`- ${JSON.stringify(mod.displayName ?? mod.gameRegistryId)}`
          + `　version=${JSON.stringify(mod.version)}　requiredVersion=${JSON.stringify(mod.requiredVersion)}`
          + `\n    status=${JSON.stringify(mod.status)}　metadataStatus=${JSON.stringify(mod.metadataStatus)}`
          + `\n    dirPath: ${mod.dirPath ?? '(null)'}`
          + `\n    tags: ${mod.tags ?? '(null)'}`)
      }
      lines.push('', `## 当前 playset: ${state.playset === null ? '(none)' : JSON.stringify(state.playset.name)}`, '')
      if (state.playset === null) {
        lines.push('（数据库里没有 playset 记录。）')
      } else if (state.playset.mods.length === 0) {
        lines.push(state.mods.length === 0
          ? '（这个 playset 里没有模组，而启动器注册表里也没有任何模组——两处同为空，才支持「确实没有启用模组」这个结论。）'
          : '（这个 playset 里没有模组，但注册表里有——播放集没把已注册的 mod 加进去。）')
      } else {
        lines.push('靠下的覆盖靠上的（wiki: "The mod lower in the playset will overwrite identical files from above"）：', '')
        for (const entry of state.playset.mods) {
          lines.push(`  position ${entry.position}　${entry.enabled ? 'enabled' : 'DISABLED'}　${JSON.stringify(entry.name)}　status=${JSON.stringify(entry.status)}`)
        }
      }
      const cross = [
        ...compareLauncherToDisk(state, config.modDir),
        ...compareLauncherToDiskFiles(state, launcherModFiles, launcherModDir),
      ]
      lines.push('', `## 与磁盘的交叉判定（${cross.length} 条）`, '')
      if (cross.length === 0) {
        lines.push(state.mods.length === 0
          ? '没有发现不一致——但这次**没有读到任何已注册模组**，所以这一行是「没读到」，不是「没问题」。'
          : '没有发现启动器与磁盘之间的不一致。')
      } else {
        for (const f of cross) lines.push(`- ${f.severity.toUpperCase()} ${f.code}: ${f.message}`)
      }
      lines.push('', '## 这次检查没有验证什么', '',
        '它读的是启动器**自己**的记录，不是游戏。启动器说 ready_to_play 不等于游戏里加载成功；'
        + 'mod 的加载顺序也只在两个 mod 改同一个文件时才起作用。'
        + `启动器自管的 mod 目录：${launcherModDir}（${launcherModFiles.length} 个 .mod 文件）。`)
      return withReceipt(lines.join('\n'))
    },
  }))

  ctx.logger?.info?.(
    `dsh-ck3-modcheck 已挂载：gameRoot ${config.gameRoot}，modDir ${config.modDir}，strict ${config.strict}，launcherDir ${config.launcherDir}`,
  )
}

/**
 * A local existence probe, used only to decide between two explanatory messages.
 * @param candidate - a path.
 * @returns whether anything exists there.
 */
async function exists(candidate) {
  try {
    await stat(candidate)
    return true
  } catch {
    return false
  }
}

/** When this module was loaded, captured once so every report can date itself. */
const LOADED_AT = Date.now()

/**
 * A dated receipt of which code files this process loaded, printed by every tool.
 *
 * **What this is, and deliberately what it is not.** It is a *receipt*, not a verdict: it reports the
 * process's own start time and the modification times of the two modules, so a reader can see that a
 * file was written after this process booted. It does **not** claim "the running code is stale" —
 * that inference was rejected once already in this project's record, because a file newer than the
 * process is not proof of what the process holds in memory.
 *
 * **Why the receipt is still worth its four lines — the staleness it can see.** Node caches a module
 * at first import, so editing `lib/rules.mjs` after the Host booted does not change what the running
 * Host serves, and every report it produces then describes the *old* rules. Measured twice on this
 * deployment: a generator kept emitting six defects that the file on disk no longer contained, and
 * one module had been picked up while its sibling had not — the two can differ. When the code is
 * edited but no file is touched afterwards, the reported mtime IS current, so the receipt stays quiet
 * in exactly that (non-problem) case rather than crying wolf.
 *
 * The probe uses `node:fs` directly rather than the Cordis-injected `fs`, on purpose: this is a
 * property of the plugin's own source files, not of the session's workspace, and it must not depend
 * on whatever sandbox policy the calling session happens to run under.
 *
 * @returns a multi-line string ending in one truly staleness-diagnostic sentence.
 */
export function moduleReceipt() {
  const here = fileURLToPath(import.meta.url)
  const dir = path.dirname(here)
  const startedAt = new Date(LOADED_AT).toISOString().slice(0, 19).replace('T', ' ')
  const files = ['index.js', 'rules.mjs'].map((name) => {
    const full = path.join(dir, name)
    try {
      return { name, mtime: statSync(full).mtimeMs }
    } catch {
      return { name, mtime: null }
    }
  })
  const listed = files
    .map((f) => `${f.name} ${f.mtime === null ? '(mtime 不可读)' : new Date(f.mtime).toISOString().slice(0, 19).replace('T', ' ')}`)
    .join('；')
  return [
    '---',
    `代码回执：PID ${process.pid}，本进程启动于 ${startedAt}（本地 ${new Date(LOADED_AT).toString().slice(4, 24)}）；${listed}`,
    '把这两个时间与上面的启动时间比：**文件比进程新 ⇒ 那份改动不在本进程里**，要重启 Host 才会生效。'
    + '进程缓存了模块，所以「文件已经改好」与「这里跑的是改好的代码」是两件事。',
  ].join('\n')
}

/**
 * Append the code receipt to a report, and return the result.
 *
 * One wrapper so the receipt cannot be forgotten on one tool and present on three — that asymmetry is
 * how a reader comes to trust a stale report.
 *
 * @param report - the rendered report text.
 * @returns the report with the receipt appended.
 */
export function withReceipt(report) {
  return `${report}\n\n${moduleReceipt()}`
}

export { CODES, SEVERITY, LANGUAGE_DIRS, hasBom, decodeText, readBytes, writeFileBytes, collectFiles, firstNonAscii }

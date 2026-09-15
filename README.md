# dsh-ck3-modcheck

Validate and scaffold **Crusader Kings III** mods from DeepSeek Harness. Four host-plane tools:

| Tool | What it does |
| --- | --- |
| `ck3_modcheck` | Validate a mod **on disk** against 39 checks — layout, both `.mod` files, paths, encodings, identifiers, brace balance, scripting vocabulary against the installed vanilla tree, and whole-file overrides of vanilla content. Read-only unless `fix: true`. |
| `ck3_mod_init` | Generate a minimal **loadable** mod skeleton, then run `ck3_modcheck` on what it just wrote so the result is proven rather than asserted. Never overwrites unless told to. |
| `ck3_mod_status` | Read the **launcher's own database** and report what the launcher thinks: registered mods, their `status`, and the active playset's load order. Read-only. |
| `ck3_mod_evidence` | Read the runtime `logs\` directory. Its unique value is the **reachability** signal — an event that is referenced but never fires — which no static check can see. Counts errors **deduplicated across sinks** (one message lands in `debug.log` + `error.log` + `game.log`, so per-file sums inflate 3×). |

Installed as a host-plane plugin under `$DSH_HOME/plugins/`, mounted by one `insert:` row in
`$DSH_HOME/profiles/web/cordis.patch.yml`. It **publishes no service** — it only registers tools into
the host `tools` registry — so it needs no `isolate` realm and cannot collide with a host service.

> **It runs on the HOST plane**, so the web profile's row is mounted at boot: after installing or
> changing the plugin, **restart the Host**. Until then, none of these tools exist in a live session.

## Config

The profile patch **replaces this row's whole `config`** rather than merging into it, so a key
omitted there silently falls back to the default below.

| Key | Default | Purpose |
| --- | --- | --- |
| `gameRoot` | `D:\Program Files (x86)\Steam\steamapps\common\Crusader Kings III` | The install root. Game data lives in `<gameRoot>\game\`. |
| `modDir` | `D:\CK3Mods` | The mod workspace. **Must be all-ASCII** — see below. |
| `strict` | `true` | When false, entry-shape and style warnings are suppressed. |
| `launcherDir` | `C:\Users\<you>\Documents\Paradox Interactive\Crusader Kings III` | Where `launcher-v2.sqlite` lives. Read by `ck3_mod_status`. |

**`modDir` must not sit under `Documents`.** The CK3 Wiki `Mod structure` page states verbatim:
*"Directory cannot include non English characters. If your Windows account name have such characters
you must use a directory outside your Documents folder."* On the machine this was written for, the
account name contains non-ASCII characters, which is why the default is `D:\CK3Mods`.

**`launcherDir` is the one path that *does* sit under `Documents`, and that is not a contradiction:**
the wiki restriction applies to a **mod's own directory**, which the game must resolve while loading.
`launcherDir` is read by Node, not by the game's mod loader, and it is the launcher's fixed location.

## What the checks rest on

Every check traces to a **primary source** — the CK3 Wiki pages (`Mod structure`, `Modding`,
`Event modding`, `Localization`, `Interface`, `Patch 1.5`/`1.13`) or a file of the real vanilla
installation — never to a recollection. The load-bearing ones:

| Rule | Source |
| --- | --- |
| `(name).mod` sits beside the folder and is required; `descriptor.mod` goes inside and omits `path` | `Mod structure`: *"without it, the launcher will not recognise the mod"*; the descriptor excludes *"the line containing the path key which is not needed in the descriptor file"* |
| `version`, `name`, `path` are required; `supported_version` is required only in the sibling file | The page's **"Required?" table** |
| `path` is relative to the **user folder** (or absolute) | *"no longer relative to the main Crusader Kings III folder, but rather to the Crusader Kings III user folder"* |
| A same-path **and same-filename** file replaces the whole vanilla file; a new filename is additive | *"If a mod has the same file as the game, it replaces all the contents of the file… Avoid doing this unless you intend to overwrite the whole file!"* |
| `replace_path` suppresses vanilla files | *"Doesn't load vanilla files for the specified path."* |
| Localization needs a UTF-8 BOM, `l_<language>:` first, and **may** omit the version counter | `Localization`; measured — **122/122** vanilla english files carry the BOM, **25,431** entries omit the counter |
| Both `localization/replace/english/` and `localization/english/replace/` are valid | `Localization`: *"Both … work, but the first path takes precedence over the other"* |
| An events file needs a `namespace`, and ids use it; ids stop at 9999 | `Event modding`; measured — **516 of 536** vanilla event files conform, and **0 of 536** filenames match their namespace |
| Load order is the playset order, lower wins | `Modding`: *"The mod lower in the playset will overwrite identical files from above."* |

Two calibrations are asserted in the test suite, because a check that flags the game's own files
teaches its reader to ignore it:

* the encoding check reports **0 findings** across the whole vanilla tree (2,536 `common` + 536 event scripts);
* the namespace check reports **exactly 20** across all 536 vanilla event files (19 mismatches + 1 missing).

## What it deliberately does NOT check

* **The tag vocabulary.** The wiki's 21-tag list is flagged *"last verified for version 1.1"* (2023)
  while the game here is 1.19.0.6; no tag list exists on disk (the launcher fetches it over the
  network), and the launcher's own database stored `["1.16 'Chamfron'"]` — a game-version string —
  with the mod's status `ready_to_play`. A membership test there reports valid mods as wrong, so only
  the **shape** is checked (list vs scalar).
* **Field-level schema validation from `_*.info` files.** Measured: only **6 of 162** contain a
  parseable `Valid <thing>:` list; they are prose documentation. They are a good thing to *cite* and
  a bad thing to *parse*.
* **Anything requiring the game to run.** A green report does not mean the game loads the mod.
  `ck3_mod_status` reads the launcher's verdict, which is stronger than ours but still not the game.

## What it cannot do

* **Prove the game loads a mod.** It reads files, and the launcher's database.
* **Judge whether the launcher *accepted* a `path=` value.** The three spellings are documented; what
  the launcher did with yours is not a property of the file.
* **See runtime failures.** CK3 writes `logs\error.log`, `logs\database_conflicts.log` and
  `logs\event_log.csv` (the last is the only way to see an event that never fires), and **this tool
  does not read them yet.** That needs the game to have been launched at least once, and a no-mod
  baseline to diff against, because the log reports errors even in an unmodded game.

## How it is checked

```sh
node test/falsify.mjs      # 121 assertions, offline
```

The suite covers each check's positive and negative case, the two vanilla calibrations above, the
write path (`applyFixes` end to end, including that a second run is a no-op), and the launcher
comparison driven by synthetic input. It does **not** prove Cordis service injection — that needs a
live harness process.

> **Why this number matters more than it looks.** The suite once passed **107/107 while the generator
> was emitting six real defects**, because every assertion then tested *structure* (does the file
> exist, is the BOM right) and none tested *function*. The generator assertions added since are
> coupled to the specific bad value they must reject, and were proven by planting those defects back:
> a bad `theme` produces 1 FAIL, a restored depth-1 `icon` produces 2, deleting the call site
> produces 1. **A suite that cannot fail is not a test**, so a green run here is only evidence
> alongside what it would have caught.

Two notes on the plugin's own contract, both measured:

* **There are no bare package imports anywhere in `lib/`.** The sanctioned installer symlinks this
  package, so a bare specifier (e.g. `@deepseek-ai/…`) fails to resolve from the link's real path
  with `ERR_MODULE_NOT_FOUND`. Only `node:` builtins and relative paths appear.
* **`bin/preflight.mjs` does not validate this plugin's config.** That script reads a row's `Config`
  export only when it is a *function*; this plugin exports the plain-object Standard Schema, so
  preflight prints `skip … (exports no usable Config schema)`. The config's own validation lives in
  `test/falsify.mjs`.

## Notes for a future editor

* `lib/rules.mjs` holds every check as a pure function; `lib/index.js` holds the Cordis wiring, the
  config schema, and the report renderer.
* `parseModFile` distinguishes **scalar** (`values`) from **list** (`lists`) syntax, and getting that
  wrong is the mistake this file has made three times: `tags` is a list, `replace_path` is a scalar.
* `collectFiles(root, { extensions: [] })` means **every file**; omitting the option means `.txt` only.
  An empty array used to mean "collect nothing", which silently disabled a check.
* Escaping braces and quotes is handled by `stripScriptNoise`; count braces on its output, never on
  raw text.

# Blueprint Atlas

A searchable index of Factorio blueprints built from the public data of
[factorioprints.com](https://factorioprints.com). Every print is decoded and analysed, so you can
search and filter by what it makes and takes, the buildings, recipes and modules it uses, game
version, Space Age, planets, mods, circuits, trains and more. Each print page shows its book
pages, an explorable schematic of every blueprint, and per-page exchange strings to copy.

Every print links back to its page on factorioprints.com and credits its author.

## How it works

```
GitHub mirror of factorioprints (motlin/factorio-blueprint-firebase-cdn, one JSON file per print)
  → sanitize      drop `favorites` (user ids) and `image.deletehash` (an Imgur secret)
  → decode        exchange string: "0" + base64 + zlib, with a cap on inflated size
  → analyse       walk books and pages: outputs, inputs, recipes, entities, rates, versions,
                  Space Age, planets, mods, circuits, trains (data/game/game-data-2.0.55.json)
  → store         D1: a slim search index, about a dozen rows per print
                  R2: the sanitised record, the analysis document and the viewer files
```

- **Pipeline:** `src/lib/server/pipeline/`, written with [Effect](https://effect.website) as
  services (`PrintSource`, `RawStore`, `PrintRepository`). The same code runs in the Worker, in
  `bun run ingest` and in `bun run backfill`. Re-runs skip prints whose content hasn't changed.
- **Search:** one FTS5 table. Besides title, description, labels, entities, recipes and community
  nicknames ("red science", "gc"), each print has a `facets` column of keyword tokens
  (`makes_item_automation_science_pack`, `v_2_0`, `sa_yes`, `uses_entity_foundry`…), so free
  text and every filter resolve in a single FTS match. Sidebar counts come from a precomputed
  `facet_counts` table when unfiltered and are counted exactly over the matches otherwise.
- **Print pages** read only the print's R2 analysis document, never D1.
- **Schematic viewer:** a Canvas2D drawing of each blueprint page from precomputed viewer files
  in R2 (belts, undergrounds, pipes, inserters, footprints), with pan, zoom, layers and hover
  details. It uses no game art.
- **Game renders (optional):** `bun run render` draws in-game-looking images offline with
  [fpsr](https://github.com/rickyzhangca/fpsr), and the viewer shows them as a second mode. By
  default it uses flat placeholder sprites generated from fpsr's metadata. Sprite atlases and
  renders made from real game sprites are never committed.
- **Icons:** item, recipe and entity icons are cells of the
  [KirkMcDonald calculator](https://kirkmcdonald.github.io)'s sprite sheet, drawn by one component
  (`src/lib/components/Icon.svelte`).
- **Admin:** `/admin/pipeline` shows backfill runs live (progress, failures, pause, resume, stop).
  It's open under `bun run dev`; deployed, it requires Cloudflare Access (see docs/deploy.md).

Stack: SvelteKit 3 on Cloudflare Workers (`@sveltejs/adapter-cloudflare`), D1, R2, Effect 4, bun,
Tailwind 4. Deploys use [Alchemy](https://alchemy.run).

## Requirements

- [mise](https://mise.jdx.dev) (installs the bun and Node versions in `mise.toml`), or bun 1.4.3
  and Node 26 on your PATH. Node is needed by wrangler's remote bindings.
- No Cloudflare account for local development: D1 and R2 run under miniflare in `.wrangler/state`.

## Local setup

```sh
mise install
bun install
bun run db:migrate                          # create the local D1 database from migrations/
bun run backfill --stage local --limit 50   # load 50 real prints from the GitHub mirror
bun run dev                                 # http://localhost:5173
```

`--limit N` picks N prints spread evenly by size across the mirror. Leave it out to load every
print (about 18,000; this takes a while and a few GB of local R2). No print data is included in
this repository.

## Commands

| Command                                                             | What it does                                                                                                                               |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `bun run dev`                                                       | Vite dev server with local D1 and R2                                                                                                       |
| `bun run check`                                                     | wrangler types check and svelte-check (app, scripts and Alchemy config); must report 0 errors                                              |
| `bun run lint`                                                      | oxlint                                                                                                                                     |
| `bun run fmt` / `bun run fmt:check`                                 | oxfmt (tabs, single quotes, width 140)                                                                                                     |
| `bun test src/lib`                                                  | unit and pipeline tests (see below)                                                                                                        |
| `bun run db:migrate` / `bun run db:reset`                           | apply migrations to the local D1 database / wipe and re-create it                                                                          |
| `bun run backfill --stage local\|dev\|prod [--limit N] [--ids a,b]` | stream prints from the mirror, at its current commit, into a stage's D1 and R2; resumable; other flags are listed in `scripts/backfill.ts` |
| `bun run backfill:status --stage …`                                 | the latest backfill runs on a stage                                                                                                        |
| `bun run ingest <id> [<id>…]`                                       | ingest specific prints into local D1 and R2 (mirror first, Firebase only for a single record not yet in the mirror)                        |
| `bun run ingest --reanalyze <id>`                                   | re-run the analysis from the stored record                                                                                                 |
| `bun run ingest --from-disk [dir]`                                  | re-ingest records saved in `data/raw/` by earlier `ingest` runs, offline                                                                   |
| `bun run render [--from-disk] [<id>…]`                              | offline fpsr renders of records in `data/raw/` into `data/renders/` and the local RENDERS bucket                                           |
| `bun run render:placeholder-assets`                                 | build the placeholder fpsr asset bundle in `.cache/`                                                                                       |
| `bun run game-data <factorio-data checkout> <kirkmcdonald json>`    | regenerate `data/game/game-data-*.json`                                                                                                    |
| `bun run gen`                                                       | regenerate `worker-configuration.d.ts` after editing `wrangler.jsonc`                                                                      |
| `bun run plan:dev`, `deploy:dev`, `deploy:prod`, `destroy:dev`      | Alchemy (see docs/deploy.md)                                                                                                               |

Tests that need real prints download a few records from the GitHub mirror at a pinned commit on
their first run and cache them in `.cache/fixtures/`, so later runs work offline
(`src/lib/server/fixtures.ts`).

## Deploying

`alchemy.run.ts` provisions two stages, `dev` and `prod`, each with a Worker, a D1 database and
two R2 buckets, in your own Cloudflare account. Log in with `bun alchemy profile edit --add
Cloudflare`, optionally set a custom domain and the `/admin` settings in `.env` (see
`.env.example`), then run `bun run deploy:dev`. Load prints with `bun run backfill --stage dev`.
The full runbook is in [docs/deploy.md](docs/deploy.md).

## Repository layout

- `src/` – the SvelteKit app, the pipeline (`src/lib/server/pipeline/`) and the viewer (`src/lib/viewer/`)
- `scripts/` – ingest, backfill, render and game-data CLIs
- `migrations/` – D1 schema
- `data/` – game data (see [data/README.md](data/README.md))
- `infra/`, `alchemy.run.ts` – Cloudflare resources

## Data sources and credits

- Prints: [factorioprints.com](https://factorioprints.com), read from the GitHub mirror
  [motlin/factorio-blueprint-firebase-cdn](https://github.com/motlin/factorio-blueprint-firebase-cdn).
  Each print belongs to its author; none are included in this repository.
- Game data: the [KirkMcDonald calculator](https://github.com/KirkMcDonald/kirkmcdonald.github.io)
  (Apache-2.0) and [wube/factorio-data](https://github.com/wube/factorio-data).
- Game renders: [fpsr](https://github.com/rickyzhangca/fpsr) (MIT).

Factorio is a trademark of Wube Software Ltd. Not affiliated with
Wube Software or factorioprints.com.

## Licence

[MIT](LICENSE). Third-party data and the prints themselves keep their own terms (see the credits above).

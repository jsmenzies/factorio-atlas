# Deploying

The site deploys to your own Cloudflare account with [Alchemy](https://alchemy.run).
`alchemy.run.ts` defines one stack, `factorio-prints`, with one deployed stage, `prod`. Local
development needs no Cloudflare account: `bun run dev` runs the same Worker on miniflare, with
its D1 and R2 under `.wrangler/state`.

For a staging environment, add a stage name to `STAGES` (and its `DATABASES` entry) in
`infra/databases.ts`, plus `plan:`/`deploy:` scripts for it in `package.json`. It gets the same
resources as prod, under its own names, and links to prod's sprites bucket.

## What gets created

The stage gets:

| Resource | Name                                  | Binding                                      | Notes                                                                 |
| -------- | ------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------- |
| Worker   | `factorio-prints-<stage>`             |                                              | the SvelteKit app; preview URLs off                                   |
| D1       | `factorio-prints-<stage>-db-<n>`      | `DB`                                         | migrations from `./migrations` applied on deploy                      |
| R2       | `factorio-prints-<stage>-raw`         | `RAW`                                        | retained on destroy                                                   |
| R2       | `factorio-prints-<stage>-renders`     | `RENDERS`                                    | game renders; optional custom domain; retained on destroy             |
| R2       | `factorio-prints-<stage>-screenshots` | `SCREENSHOTS`                                | copies of the prints' screenshots; optional custom domain; retained   |
| R2       | `factorio-prints-sprites`             | `SPRITES`                                    | game icons, owned by prod; optional custom domain; retained           |
| Assets   | `.svelte-kit/cloudflare`              | `ASSETS`                                     | client files; honours the adapter's `.assetsignore`, `_headers`       |
| Access   | `factorio-prints-<stage> admin`       |                                              | Zero Trust application on `<domain>/admin*`; see "Admin page"         |
| Cache    | the zone's cache rules                |                                              | prod, with a sprites, renders or screenshots domain; see "Edge cache" |
| Limits   | three Workers rate limits             | `PAGE_LIMIT`, `SEARCH_LIMIT`, `REPORT_LIMIT` | per visitor; see "Rate limits" and "Removal requests"                 |
| Views    | `factorio_prints_<stage>_views`       | `VIEWS`                                      | Analytics Engine dataset; see "Page views"                            |
| Worker   | `factorio-prints-<stage>-views-cron`  |                                              | daily jobs: views rollup (`ANALYTICS_API_TOKEN`), abandoned deletions |
| WAF      | the zone's rate-limiting rules        |                                              | prod, with a site domain; see "Rate limits"                           |
| Bots     | the zone's Bot Fight Mode             |                                              | prod, with a site domain; see "Rate limits"                           |

Prod's D1 database is retained on destroy (a staging stage's would be deleted). `<n>` is the D1
generation from `infra/databases.ts` (1 by default).

The Worker is the adapter-cloudflare build (`bun run build`), bundled by Alchemy the way
`wrangler deploy` would bundle it. Binding names, `vars`, the compatibility date and flags are
read from `wrangler.jsonc`, so local and deployed Workers match. Alchemy also adds the
`new_module_registry` flag to every Worker.

`wrangler.jsonc` itself is only for local tooling (`bun run dev`, `bun run db:migrate`,
`bun run preview`, `bun run check`); its `database_id` is a placeholder that keys the local
miniflare database. Never `wrangler deploy` with it.

## Before the first deploy

1. **Workers Paid** on the account is recommended (Workers & Pages → Plans). Nothing in the
   stack sets plan-only options. Workers Logs is on by default.
2. **A workers.dev subdomain** on the account (Workers & Pages → Settings). The state store
   and any stage without a custom domain need it.
3. **Log in** on each machine: `bun alchemy profile edit --add Cloudflare` (browser OAuth). Pick
   the **Developer Platform** scopes, plus **DNS & Zones** if you use a custom domain,
   **Cache & Performance** and **Rules & Configuration** for the cache rule ("Edge cache"), and **Cloudflare One / Zero Trust**
   for the admin page's Access application. Check with
   `bun alchemy profile show`; to add a scope later, `bun alchemy profile edit --reconfigure Cloudflare`.
4. **Copy `.env.example` to `.env`** and set what you need (all optional):

   ```sh
   SITE_DOMAIN_PROD=example.com
   SPRITES_DOMAIN=sprites.example.com
   RENDERS_DOMAIN_PROD=renders.example.com
   SCREENSHOTS_DOMAIN_PROD=screenshots.example.com
   ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com
   ADMIN_EMAIL=you@example.com
   TURNSTILE_SITE_KEY=0x…
   TURNSTILE_SECRET_KEY=0x…
   CACHE_PURGE_TOKEN=…
   ALCHEMY_TELEMETRY_DISABLED=1
   ```

   A domain's zone must already be in the account. When `SITE_DOMAIN_<STAGE>` is set, the
   hostname is attached as a Worker custom domain and the `workers.dev` URL is turned off. Unset
   leaves domains alone (it never detaches one). `SPRITES_DOMAIN`, `RENDERS_DOMAIN_<STAGE>` and
   `SCREENSHOTS_DOMAIN_<STAGE>` are the sprites, renders and screenshots buckets' own hostnames: see
   "Icons", "Edge cache" and "Screenshots". The Turnstile keys and `CACHE_PURGE_TOKEN` are for
   "Removal requests".

5. **For CI only**, an API token (My Profile → API Tokens → Custom), scoped to the account:
   - Account → Workers Scripts: Edit; D1: Edit; Workers R2 Storage: Edit;
     Secrets Store: Edit (the state store needs Edit, not Read); Account Settings: Read.
   - Optional: Account → Workers Tail: Read (for `alchemy logs`).
   - With a domain, scoped to that zone: Zone: Read; Workers Routes: Edit; DNS: Edit; with a
     sprites or renders domain also Cache Rules: Edit and Zone Settings: Edit, and Account → Account Rulesets: Edit and
     Account Filter Lists: Edit ("Edge cache").
   - For the admin page: Account → Access: Apps and Policies: Edit.

   Store it as `CLOUDFLARE_API_TOKEN`, with `CLOUDFLARE_ACCOUNT_ID`, in your CI secrets, never in
   the repo. If a deploy reports a missing permission, add that group.

## Deploy

```sh
bun run plan:prod      # build, then show what would be created or changed
bun run deploy:prod    # build, show the plan, ask for confirmation, then deploy
```

The first plan or deploy asks to deploy Alchemy's **state store** (below), once per account.
`deploy:prod` then creates the D1 database and applies the migrations, creates the buckets,
deploys the Worker and prints its URL.

There is no destroy script. Removing a stage (`bun run build && bun alchemy destroy --stage
<stage>`) deletes its Worker, custom domain and Access application, keeps its buckets and prod's
D1 database (Alchemy forgets them), and deletes a staging stage's D1 database. To re-attach kept
resources on a later deploy, add `--adopt`.

Always pass a stage. Without `--stage`, Alchemy uses `live_<user>`, which `alchemy.run.ts`
rejects.

## Migrations

- On every deploy, Alchemy applies any new `migrations/*.sql` file in numeric order and skips
  applied ones. The Worker depends on the database, so migrations run before the Worker is
  updated, and must stay compatible with the Worker that is still live while they run.
- Applied migrations are recorded in Alchemy's `__alchemy_migrations` table. A database
  migrated by `wrangler d1 migrations apply` has its `d1_migrations` history copied in once.
  Don't run `wrangler d1 migrations apply --remote` against deployed databases.
- Never change an applied migration's SQL; add a new numbered file.
- Locally, `bun run db:migrate` applies them with wrangler (`--local`).

## Where state lives

`state: Cloudflare.state()`: a state-store Worker with a Durable Object (SQLite, encrypted at
rest) in your account. Its bearer token sits in a Secrets Store. Alchemy creates it on the first
deploy after asking, and stores a credential under `~/.alchemy/` on each machine. In CI it reads
the token from the Secrets Store. Every machine and CI therefore see the same state. Local files
under `.alchemy/` (bundles, caches) are gitignored. Don't run two deploys of the same stage at
once.

## Loading prints

The backfill streams every print from the mirror, at one commit, into the stage's D1 and R2,
through wrangler's remote bindings. It needs `bunx wrangler login` and Node on PATH. Try it on the
local stage first (`--stage local`, the database `bun run dev` uses).

```sh
bun run backfill --stage prod --limit 200   # a sample first
bun run backfill --stage prod               # everything; resumable, re-runs skip unchanged prints
bun run backfill:status --stage prod
```

By default records come from GitHub at the mirror's current commit, one request each. With a
local clone of the mirror, `--from-clone <dir>` reads them from disk instead, at the clone's
checked-out commit (the run's source is then `clone@<sha>`):

```sh
git clone --depth 1 https://github.com/motlin/factorio-blueprint-firebase-cdn.git ~/factorio-mirror
bun run backfill --stage prod --from-clone ~/factorio-mirror
```

The account is taken from `CLOUDFLARE_ACCOUNT_ID`, or the only account `wrangler whoami` lists.
`--stage prod` asks for confirmation unless `--yes` is given. While it runs, the terminal and
`/admin/pipeline` show progress, failures and D1/R2 usage, and both can pause, resume or stop it.

Each run ends by recomputing which prints are exact copies of others (the soft fold: every later
copy, whoever posted it, is left out of search and points at the earliest print). To check it, or to
finish it after a run was quit, `bun run fold` rebuilds it from scratch and writes only differences:

```sh
bun run fold --stage prod --dry-run   # after a backfill: reports 0 rows to change
bun run fold --stage prod             # writes what differs, then rebuilds the facet counts and bumps the page cache
```

## Icons

Game icons are static files in one R2 bucket, `factorio-prints-sprites`. Prod's deploy creates
it; a staging stage would only link to it. Keys are
`icons/<game version>-<content hash>/<type>/<name>.webp`. Each object is uploaded with
`cache-control: public, max-age=31536000, immutable`; a new icon set gets a new hash, so a file
never changes. `data/game/icons.json` (committed) names the set the site links to and which icons
it has; the icons themselves are made on your machine and never committed.

1. Export them from the game: `factorio --dump-icon-sprites` writes PNGs to
   `script-output/<type>/<name>.png` in the game's user data folder.
2. `bun run icons <that script-output folder>` writes `data/sprites/` and `data/game/icons.json`
   and loads the local bucket. It needs `cwebp` (libwebp) on PATH.
3. After `bun run deploy:prod` has created the bucket, `bun run icons --upload remote` uploads the
   set with `wrangler r2 bulk put --remote` (needs `bunx wrangler login`). Wrangler's API limit
   makes this take about 10 minutes for 2,400 icons. Upload before deploying a Worker that links
   to a new set.

**Serving.** With `SPRITES_DOMAIN` set (a hostname in a zone in the account), the bucket is
public on that hostname only, and the Worker's `SPRITES_URL` points pages at it: browsers fetch
icons from R2 through Cloudflare's CDN and never invoke the Worker. Cached hits are free; misses
are R2 Class B reads; R2 has no egress fees. CORS allows `GET` from any origin, so a canvas on
the site can read the pixels. Unset, Alchemy removes the bucket's custom domain and prod's Worker
serves the same files at `/sprites/<key>`, which costs a Worker request per icon the browser
doesn't have cached yet (a staging stage would then show blank icons).

## Edge cache

Icons and render images are served straight from their buckets' custom domains, through
Cloudflare's cache, without invoking the Worker. With `RENDERS_DOMAIN_<STAGE>` set the renders
bucket is public on that hostname only, and the Worker's `RENDERS_URL` points the viewer at it;
unset, the Worker serves the same files at `/prints/<id>/render/<file>` (a Worker request and an R2
read per image the browser doesn't have yet).

Nothing is ever purged. Every image's name changes when its pixels do: tiles are named by a hash of
their pixels (`t/<hash>.avif`), overviews by their render's stamp (`<page>.<stamp>.avif`). So
images are uploaded with `cache-control: public, max-age=31536000, immutable`, and a re-rendered
page simply links to new names. Only the JSON files keep their names: a page's sidecar and entity
data (`<page>.json`, `<page>.page.json`, `max-age=300`) and the print's `index.json` (its rendered
pages, `max-age=60`). Each page's images go up before its sidecar, and the index last, so a page
never links to images that aren't there yet (see "Uploading renders"). The other way round, a
browser or the edge may still hold a sidecar or index from before a re-render for up to six minutes
and ask for the images it names, so replaced images are deleted only after a grace period: a 404
would be cached as well.

Cloudflare caches only some file types by default, so prod's deploy also manages, on the zone of
those hostnames:

- one **cache rule** that makes every response on the sprites, renders and screenshots hostnames eligible for
  cache and keeps each object's own `cache-control` for the edge and browser TTLs. The rule list is
  the zone's whole cache-rules phase, so a deploy would delete a cache rule made anywhere else on
  that zone (dashboard, another tool). Instead, plan and deploy stop with an error that names
  each such rule; add it to `alchemy.run.ts` or remove it from the zone, then run them again;
- **Smart Tiered Cache**, so a miss in one data centre is filled from an upper tier before R2.
  Removing the domains restores the setting it had before.

Cloudflare may still evict a file nobody has asked for in a while, whatever its TTL; the next
request then reads it from R2 again (a Class B read; R2 has no egress fees). Check a file with
`curl -s -o /dev/null -D - https://renders.example.com/<id>/index.json` (a GET: Cloudflare reports
every HEAD request, `curl -I`, as `DYNAMIC`): `cf-cache-status` is `MISS` the first time
and `HIT` after, and `age` counts up.

## Page cache

The search page, print pages and the full-screen render page (their HTML, and the `__data.json`
the browser fetches when you click between pages) are kept in each Cloudflare location's cache by
the Worker itself (`src/lib/server/page-cache.ts`, from `hooks.server.ts`), so a repeat visit
reads neither D1 nor R2. Entries last an hour for searches and a day for print pages. Only `200`
responses without cookies are kept; `/admin`, the view counter, errors and `429`s never are. The
rate limits run first, so cached pages still count towards them. Browsers get `cache-control:
no-cache`, and every response says `x-page-cache: hit` or `miss`.

Nothing is deleted to purge it. Every key holds the build (new on each deploy) and the data
version, `meta.sync_version` in D1, and everything that changes what pages show bumps that
version: the ingest and backfill, `bun run render:flags`, the views sync (daily Worker and
`views:sync`) and `bun run authors`. Each Worker instance rereads the version at most every 30 s,
so a change shows everywhere within about half a minute and the old entries simply expire. After a
change made some other way (SQL by hand), bump it yourself:

```sh
bunx wrangler d1 execute <database> --remote --command \
  "INSERT INTO meta (key, value) VALUES ('sync_version', strftime('%s','now')) ON CONFLICT (key) DO UPDATE SET value = excluded.value"
```

Check a page with `curl -s -o /dev/null -D - https://example.com/` twice: `x-page-cache` is `miss`
and then `hit`. The cache is per location, so the first visit in each location is a miss.

## Rate limits

Two layers keep one visitor from running up the bill:

- **In the Worker** (`src/lib/server/rate-limit.ts`, run from `hooks.server.ts`): the Workers Rate
  Limiting bindings declared in `wrangler.jsonc` (`ratelimits`). Every request counts towards
  `PAGE_LIMIT` (150 per 60 s) and every search, the home page with a query string, towards
  `SEARCH_LIMIT` (40 per 60 s) as well, and every sign-in step (`/auth/…`) and account change
  towards `AUTH_LIMIT` (10 per 60 s), and every upload, edit or delete of one towards `UPLOAD_LIMIT`
  (10 per 60 s). A visitor is the client's IPv4 address or IPv6 /64, and
  counts are kept per Cloudflare location and are approximate. Over a limit the answer is a `429`
  with `Retry-After: 60`. `/admin` is exempt, and `bun run dev` has no limits (`bun run preview`
  does). Periods can only be 10 or 60 s; `namespace_id` must be unique in the account.
- **At the edge**, with a site domain: one WAF rate-limiting rule (the one the Free plan allows) on
  the site's hostname, outside `/_app/`, blocks an IP for 10 s once it sends 60 requests in 10 s in
  one data centre. Blocked requests never run the Worker. Prod owns the zone's whole rate-limit
  phase, so, as with the cache rule, plan and deploy stop if it holds a rule made elsewhere.
- **Bot Fight Mode**, with a site domain, on the same zone: Cloudflare challenges traffic it is sure
  is automated, while verified bots (search engines, link previews, the larger uptime monitors)
  pass. It covers every hostname in the zone and can't be skipped per path on the Free plan.

Test the Worker's limits with `bun run preview`, or on the site with
`for i in $(seq 160); do curl -s -o /dev/null -w '%{http_code}\n' https://example.com/robots.txt; done | sort | uniq -c`
(the edge rule may answer first: its block is a `429` from Cloudflare, not the Worker's text).

## Security headers

Every response the Worker sends carries HSTS (a year, this host's subdomains), `nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, a Permissions-Policy and
`Cross-Origin-Opener-Policy: same-origin` (`src/lib/server/security-headers.ts`). Files served
without the Worker (`/_app/`, `static/`) get the first three from `_headers` in the project root,
which adapter-cloudflare copies into the build. Pages also get a Content Security Policy from
SvelteKit's `csp` option in `vite.config.ts`, in nonce mode: scripts from the site only (SvelteKit's
start-up script carries the nonce, and the one inline handler Svelte writes on images is allowed by
its hash), images from any https host (descriptions embed them), no framing. Cloudflare reads the
nonce from the header and adds it to the scripts it injects (Bot Fight Mode's JavaScript detections);
Web Analytics' `static.cloudflareinsights.com` is allowed too. Check a deployed page in the browser
console: any CSP violation there means something it needs is blocked.

## Uploading renders

`bun run render` draws pages into `data/renders/` on your machine, or the folder `RENDERS_DIR` names
(in `.env`; worth it, since a full set is millions of files that editors try to index). Every run,
the uploader and the local site use that folder; its sidecars are what tell a run a page is
unchanged, so a run stops if the folder has none of the pages already done (`--force` redraws
instead). The script header in `scripts/render-game.ts` has every flag. With `--upload prod` it also puts each finished page into
the stage's renders bucket, `factorio-prints-prod-renders`, while the run goes on, through R2's
S3-compatible API (`https://<account id>.r2.cloudflarestorage.com`); `--upload local` fills the
local bucket instead. Pages rendered by an earlier run that aren't up yet go first, so a run with
`--upload` and nothing left to draw only uploads.

1. In the dashboard, R2 → Manage API tokens → Create API token: **Object Read & Write**, applied
   to the stage's renders and screenshots buckets (`factorio-prints-<stage>-renders` and
   `factorio-prints-<stage>-screenshots`): render uploads use the first, screenshot uploads the second,
   and deletions made outside the Worker (`bun run polled`) list and delete in both.
2. Put its key pair in `.env` (never commit it):

   ```sh
   R2_ACCESS_KEY_ID=…
   R2_SECRET_ACCESS_KEY=…
   ```

   The account comes from `CLOUDFLARE_ACCOUNT_ID`, or the only account `wrangler whoami` lists.

3. Run, for example:

   ```sh
   bun run render --from-clone ~/factorio-mirror --next 100 --upload prod
   bun run render:resume        # after a stop or a crash: the same options again
   bun run render --from-clone ~/factorio-mirror --next 1000 --top 1000 --upload prod   # the 1,000 most-favourited first
   bun run render --from-clone ~/factorio-mirror --next 100 --upload prod --flags       # then the search flags and a page-cache bump
   ```

Per page, in this order: its tiles not in the bucket yet (checked against one listing of the
print's prefix), the overview, the entity data, the sidecar, then the print's `index.json` rebuilt
from the pages that are up. Every object carries the `cache-control` described in "Edge cache".
What is up is recorded per page in the local D1 (`render_uploads`), after the index; a run that is
stopped or killed sends at most the pages that were in flight again, and nothing that made it up.

Replaced files are deleted after a grace period of 15 minutes, not at once: a re-rendered page's
previous overview, tiles no page uses any more (looked for once every page of the print in the
bucket is the version on disk) and the files of pages a print no longer has. A browser or the edge
may hold a page's sidecar (cached 300 s) or the print's index (60 s) from before the re-render and
ask for the files it names; deleted at once, they would give a 404, which the edge caches too. Each
file to delete is recorded in the local D1 (`render_deletes`) with the time it may go. Every run
with `--upload`, as it starts and again before it exits, deletes the files that are due, after
checking that no page in the bucket uses them again; a page that goes up cancels the deletions of
the files it uses, so a page that goes back to an earlier render keeps them. A print with no page
left loses its `index.json` at once. The run's summary counts the deletions scheduled and still
pending, and a run with nothing else to do still deletes what is due. For a test against the local
bucket, `RENDER_DELETE_GRACE_S=<seconds>` shortens the wait (below 360 s only with
`--upload local`). Files in the renders folder itself are removed at once, since the local site reads
them from disk.

Page thumbnails (`<page>.<stamp>.t320|t640|t960.avif` and `thumbs.json` per print) are made by the
run from each print's finished overviews into `data/thumbs/`, or the folder `THUMBS_DIR` names, and
with `--upload` go up after that print's render files: the new thumbnails, then `thumbs.json`. What
each bucket holds is recorded per print in the local D1 (`thumb_uploads`), so an unchanged print
costs no request, and replaced thumbnails wait in `render_deletes` like replaced overviews.
`bun run render:thumbs --ids … | --all` makes them for any rendered prints without a render run, and
`bun run render:thumbs --upload prod --all` uploads them.

`--upload-concurrency N` sets the requests in flight (default 32); requests, deletions included,
are retried with backoff on network errors, 429 and 5xx, and a 401 or 403 stops the uploads for the
run (rendering goes on). The run exits with code 3 when pages are left to upload. `/admin/render`
shows upload progress, pending deletions and errors.

### The "Only prints with a render" filter

The search page's filter reads the stage's D1, not the bucket: `print_renders` (one row per print
with at least one page up) and a `render_yes` token in each such print's search row. After uploads,
run:

```sh
bun run render:flags --stage prod --dry-run   # what would change
bun run render:flags --stage prod             # asks before writing; --yes skips that
```

It reads what is up from the local D1 (`render_uploads` and `render_jobs`, read-only, so it can run
beside a render run), compares it with the stage, and writes only the difference in batches, setting
and unsetting rows and tokens; running it again writes nothing. Rows may name prints the stage
hasn't ingested yet: the backfill adds the token whenever a print's row exists, so the order of
backfill and renders doesn't matter, and a re-ingest keeps it. `--stage local` also counts renders in
the renders folder, which the local site reads first. Prod goes through the backfill's remote bindings
(`wrangler login`, Node on PATH), and the deployed database must have migration 0018.

It also gives each flagged print its cover thumbnail for search cards (the first page of the
`thumbs.json` uploaded to that bucket; `print_renders`' cover columns), and bumps the stage's page
cache when it writes anything.

`--flags` on an upload run (`bun run render … --upload prod --flags`, or `bun run render:thumbs
--upload prod --all --flags`) runs the same thing for the upload target once the uploads are done,
without asking (the flag is the consent). It also bumps the page cache when the run replaced a page
at a new stamp, removed a page, or scheduled files for deletion, since cached pages name those files
and they go after the grace period. It never fails the run: when it can't finish, it prints the
command to run by hand (`bun run render:flags --stage prod --bump`) and the run exits with code 4. It
runs before the run's row is final (even after a stop or a failure), so the run's pages show it as the
last phase.

## Screenshots

Each print's screenshot was uploaded by its author to Imgur for factorioprints.com. The site keeps
its own copy in the stage's screenshots bucket, `factorio-prints-<stage>-screenshots`, and shows
that. Imgur's copy is shown only while an image isn't copied yet; never once it is known to be gone
from Imgur or taken down. Files are keyed by Imgur id
(`src/lib/screenshots.ts`): the original exactly as Imgur served it (scaled down when over
3840 × 2160 pixels or 8,192 px on a side), 16:9 crops for search cards and the print header, a
"large" size for the lightbox, a JPEG for link previews, and a small manifest per image that the
print and render pages read. With `SCREENSHOTS_DOMAIN_<STAGE>` set the bucket is public on that
hostname through the cache rule above; unset, the Worker serves the files at `/screenshots/<key>`.

Everything runs on your machine, into the folder `SCREENSHOTS_DIR` names (in `.env`; about 17 GB
for every print):

```sh
bun run screenshots --from-disk                  # fetch originals from Imgur (paced; resumable)
bun run screenshots --make                       # make the sizes (optional: --upload makes what's missing)
bun run screenshots --upload prod                # files, then each image's manifest; asks nothing of Imgur
bun run screenshots:flags --stage prod           # the `screenshots` table search cards read; purges cached pages
```

The upload uses the same kind of R2 API token as "Uploading renders": **Object Read & Write** on
the screenshots bucket (a token limited to the renders bucket must be edited to include it). Every
put and delete is recorded in `<SCREENSHOTS_DIR>/uploads/<stage>.jsonl`, so an unchanged image costs
no request and `screenshots:flags` knows what is up. A copied image is never checked against Imgur
again: one deleted there stays shown here until someone asks for its removal ("Removal requests"
below, or `screenshots:remove`).

### Screenshot removal requests

The site footer links to a GitHub issue form ("Remove a screenshot"). To act on one:

```sh
bun run screenshots:remove --stage prod --ids=<print id or Imgur id> --reason "author's request" --dry-run
bun run screenshots:remove --stage prod --ids=<print id or Imgur id> --reason "author's request"
```

It marks the image removed in the local run state, deletes its files from the bucket at once and
writes a 'removed' manifest, records it in the stage's `screenshot_removals` table, sets its card
row 'removed' (also for a print whose screenshot was never copied) and purges cached pages. Nothing shows it any more, nor Imgur's copy. Cloudflare's edge may
still serve a deleted file at its old address: purge the addresses the script prints (Caching →
Configuration → Custom Purge).

## Removal requests

Every print page links to a form (`/prints/<id>/remove`, noindex and disallowed in robots.txt) where
anyone can ask for the print to be removed, with a reason, optional details and optional contact
details. Requests wait in `/admin/reports` ("Admin page"); nothing happens to a print until an admin
approves one. The form is guarded by Cloudflare Turnstile and the `REPORT_LIMIT` rate limit (5 sends
per minute per visitor), and keeps at most 20 open requests per print. The daily cron Worker clears
contact details and free text 30 days after a decision.

**Approve** takes the print down at once, in the site Worker (`src/lib/server/takedown.ts`), in an
order that never lets a page be cached as live again:

1. `removal_blocks` (migration 0021) gets the print's id, its factorioprints id and, when it goes,
   its screenshot's Imgur id, and a tombstone in `print_tombstones` makes its pages answer **410 Gone**
   from then on, whatever R2 still holds. Every ingest checks the blocks: the backfill leaves blocked
   prints out of its listing, and the database itself refuses a blocked print's `prints` row (a
   trigger), so an ingest that was already running can't bring it back.
2. RAW (analysis document first, then the archived record and viewer files) is deleted.
3. Its D1 rows go (`prints`, the search index, `ingest_state`, `print_renders`).
4. Everything under `<id>/` in RENDERS (renders and thumbnails) is deleted.
5. The screenshot's files are deleted and its manifest says 'removed', unless another print uses the
   same image (tick "Screenshot even if shared" to remove it anyway).
6. The renders folder and the screenshot's files are purged from the edge cache, given
   `CACHE_PURGE_TOKEN`.
7. A page-cache bump, last.

The request counts as done only when every step, the purge included, worked. Otherwise the decided list
shows "Not finished" with the error and what is still to purge; "Run takedown again" finishes it and
purges what earlier runs couldn't (the Free plan allows 5 purge requests a minute, so several approvals
in a row can be refused for a minute). Without a purge token, purge the listed prefix and addresses by
hand (Caching → Configuration → Custom Purge), then press "I purged these by hand".
**Reject** only records the decision.

The machine that renders keeps its own copies (render queue rows, renders and thumbnails on disk,
screenshot copies). After approving, run there:

```sh
bun run removals --stage prod --dry-run
bun run removals --stage prod          # asks before writing; --yes skips that
```

It copies prod's blocks into the local D1 (the backfill, render runs, `render:top`, `render:thumbs
--upload` and `render:flags` skip blocked prints), deletes the deleted prints' local rows, folders and
archived records, deletes any render a running upload put back in prod's bucket (once per deleted
print: it remembers what it swept, so a run with nothing new says "nothing to do"), and takes the
screenshots down in the screenshot run state and the upload ledger. It refuses while a render run is
live, and needs the R2 API token ("Uploading renders"). `--json` puts the result on stdout as JSON
(the last line) and everything else on stderr. The deployed database must have migration 0021.

**Setup:**

- **Turnstile:** in the dashboard, Turnstile → Add widget, for the site's hostname, mode Managed. Put
  its keys in `.env` as `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`; the deploy binds the secret.
  Without both, the deploy warns and the form says requests aren't available (it is never left
  unguarded). Locally, `wrangler.jsonc` has Cloudflare's always-passing test key.
- **Edge purge:** an API token (My Profile → API Tokens → Custom) with **Zone → Cache Purge →
  Purge**, limited to the zone of the renders and screenshots domains, as `CACHE_PURGE_TOKEN` in
  `.env`. The deploy binds it with the zone's id (`CACHE_ZONE_ID`) when the stage has those domains.
  Deletions made outside the Worker (`bun run polled`, the update's other-sites step) read both from
  `.env`, so add the zone's id there too as `CACHE_ZONE_ID` (the zone's Overview page, "API" → "Zone
  ID"); without it, or without `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`, those deletions wait. They
  also wait while the R2 token can't list the renders or screenshots bucket, or the stage's RAW bucket
  (read through your wrangler login): each run checks with one listing of an empty prefix.

## Page views

The search page's "Popular this month" sort orders prints by their views over the last 30 days.
Each print page sends one request when it opens in a browser (`POST /prints/<id>/view`, once per
print per tab), and the Worker writes one Analytics Engine data point to the stage's dataset holding
only the print id: no IP address, user agent or cookie. The request is a keepalive `fetch`, not
`navigator.sendBeacon`, because privacy extensions block every beacon. Requests whose user agent
looks automated aren't counted, and hover preloads never send it. Cloudflare creates the dataset on
the first write and keeps data points for three months. The counts are never shown on the site.

The counts reach D1 (`prints.views_30d`) once a day, at 04:17 UTC, from a small scheduled Worker,
`factorio-prints-<stage>-views-cron` (`src/cron/views.ts`). It totals the stage's dataset through
the Analytics Engine SQL API and writes only the counts that changed; prints with no views in the
window go back to 0. Its runs and any errors are in the Worker's logs in the dashboard. A re-ingest
keeps a print's count; a fresh D1 database starts at 0 until the next run.

The same sync runs by hand, to refresh the order now or to copy prod's counts into the local D1:

```sh
bun run views:sync --stage prod --dry-run   # what would change
bun run views:sync --stage prod             # asks before writing; --yes skips that
bun run views:sync --stage local            # prod's counts into the local D1
```

The SQL API needs an API token of its own, since `wrangler login` can't read analytics. Create one
in the dashboard (My Profile → API Tokens → Create Token → Custom token) with one permission,
**Account → Account Analytics → Read**, limited to the site's account, and put it in `.env` as
`ANALYTICS_API_TOKEN`. Don't name it `CLOUDFLARE_API_TOKEN`: wrangler and Alchemy would pick that up
in place of your login. The deploy binds it to the cron Worker as a secret; without it the deploy
warns and skips that Worker. `views:sync` reaches prod's D1 through the backfill's remote bindings
(`wrangler login`, Node on PATH), and the deployed database must have migration 0016.

## Author names

Most factorioprints records carry only the author's user id; the name is kept in Firebase's public
`users/<id>/displayName`. `bun run authors` puts names on a stage's prints: on the search cards, in
the search index (typed text finds an author; `?author=<id>` lists their prints, linked from each
print page) and in each print's R2 document. Names come from the prints' own records first, then
one Firebase lookup per remaining author, at most 5 a second, since Firebase's bandwidth is billed
to factorioprints. Every answer is kept, in the stage's `authors` table (migration 0017) and in
`.cache/authors/firebase.json`, so no author is ever looked up twice, from any stage. A print whose
record names its author keeps that name.

```sh
bun run authors --stage prod --dry-run   # what it would do
bun run authors --stage prod             # asks before writing; --yes skips that; Ctrl-C stops and saves
bun run authors --stage local            # the local D1 and bucket (reuses earlier answers)
```

It's resumable: a stopped run saves what came back, and the next one carries on (`--limit N` asks
about at most N authors). New prints get their author's name at ingest when the table has it; run
the command again to look up authors who are new to the site. It reaches prod through the
backfill's remote bindings (`wrangler login`, Node on PATH), and the deployed database must have
migration 0017.

## Swapping in a fresh D1 database

D1 databases are numbered per stage in `DATABASES` in `infra/databases.ts`.

1. Set `importTarget: 2` for the stage and deploy. Alchemy creates
   `factorio-prints-<stage>-db-2` and runs the migrations on it, but doesn't bind it. The
   site keeps using db-1.
2. Fill db-2, for example with `bun run backfill --stage <stage> --db 2` and
   `bun run render:flags --stage <stage> --db 2`, and check it with
   `bunx wrangler d1 execute factorio-prints-<stage>-db-2 --remote --command "…"`.
3. Set `bound: 2` and remove `importTarget`, then deploy. The Worker is rebound to db-2 in one
   deploy.
4. In prod, db-1 is retained: Alchemy forgets it but it stays in Cloudflare as a rollback. To
   roll back, set `bound: 1` and deploy (add `--adopt` if Alchemy says the database isn't its
   own). On a staging stage, db-1 is deleted by that deploy.

## Keeping up with the mirror (`bun run sync`)

One update brings a stage up to date with the print sources (today the mirror), on the machine
that renders (it needs the mirror clone, the sprite assets and the renders folder):

```sh
bun run sync                 # prod; asks for "prod" unless --yes
bun run sync --plan          # fetch the mirror and say what an update would do; changes nothing
bun run sync --accept <hash> # let a held-back mirror commit through on the next update
bun run sync --accept codex  # let the change the last check held back on codex through (or codex:<id>)
bun run sync --stage local   # try it on the local stage
```

In order, each step being the command you'd otherwise run by hand:

1. Removals: `removals --stage … --yes --json`, this machine's copies of prints the site deleted (see
   "Removal requests"). It runs whatever else happens; if it fails, the update says so and skips
   screenshots and render, which could otherwise put a removed print's files back.
2. Fetch: for the mirror, `git fetch`, a comparison by print id, then a fast-forward. A source is
   held back, and only it, by one rule for every source: when its new and removed prints in one
   update (the mirror's moved files too, as a layout change would bring) are more than 5% of the
   prints this machine knows from it and more than 25; edits never count. A first import (nothing
   known yet) is held back once too, and so is a source that would be left with no prints, or a clone
   with commits the mirror doesn't have. The message names the counts ("62 new, 3 removed: more than
   5% (25 at least) of 466"). Once you've looked at the source, `bun run sync --accept <commit>` for the
   mirror, `bun run sync --accept codex` (or `codex:<id>`, the id `--plan` names) for another site, or
   Accept on the Update tab lets that change through.
3. Ingest: `backfill --from-clone`, skipped when neither the sources nor the analyzer, index or
   viewer version changed since the last update that ran it to the end. A backfill whose failures
   aren't the records' own (storage, the network, a worker) doesn't count as the end.
4. `authors`, then 5. `screenshots`, `--upload` and `screenshots:flags`.
5. Render: `render:top` and `render:check`, then `render --next … --upload … --flags`.
6. The stage's counts.

A failed step is marked and the steps that don't need it still run; authors and render need ingest,
screenshots and render need removals.

**Other sites polled for prints** (factoriocodex.com, through its public JSON API, and fprints.xyz,
through its sitemap and the import API it offers other sites; each on by default, the Update tab at `/admin/update`
turns either off): in the fetch step the update lists the site's prints by last change until it is
past the newest change it has seen (usually one request; fprints' sitemap lists every print in one),
reads each new or changed print (codex's with `?skip_view=true`, so no view is counted), and keeps it
in the record store's inbox
(`<RECORDS_DIR>/.polled/<site>/`). Every request sends a User-Agent naming this project, at most one
a second; an update reads every new or changed print (no cap; a stop leaves the rest for the next one). When the
site's total doesn't match what this machine knows, and once a week, it lists every page (fprints:
every update): a print missing from the list is read once more, and a 404 (fprints: its API's "no
rows" answer) or a print no longer public is a deletion (a print
the list still shows is never one: its failed read is tried again). fprints' sitemap is a file the
site rebuilds now and then, not a live list, so its new prints and edits are seen only once it is
rebuilt, and a print deleted or made private while still listed is a failed read (tried again, never
a deletion) until then. New and missing prints past the hold-back rule above, or an empty list, hold the
site back until accepted (the reads also find no more prints gone than that rule allows). In the ingest step,
after the backfill, `bun run polled --stage … --site codex|fprints` puts every new or changed record through
the same gate as any print (blocks, joins with the same blueprint already here, suggestions), and
each deletion as a source gone: kept while another site has the print, else deleted with its renders,
the edge cache and our copy of its screenshot (on prod this needs `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `CACHE_PURGE_TOKEN` and `CACHE_ZONE_ID` in `.env`; without any of them the
deletions wait for a run that has them). An edit that makes one of a print's sources a different
blueprint splits it: the print stays with the source it was first added from (its URL), and the
others become prints of their own. `bun run polled … --dry-run` says what each record would become without
writing. The prints that are their own print then reach the record store (`bun run records`), so the
render step draws them. A print's image on that site (codex's on Backblaze B2, fprints' on its Bunny CDN) is never linked to: the
screenshots step's `screenshots --from-sites …` copies the images the stage's prints show, from their
URLs (at most one request a second, each site's own image host only, no redirects; dead only after a 404 on two
runs), into the same pipeline as Imgur's, and until then the print shows none.
Prints deleted from the mirror are counted and kept. Each update is a `sync_runs` row in the local
D1 (migration 0020, so run `bun run db:migrate` first) and one log, `sync-<time>.log`, in the run
logs folder (`<renders dir>/logs/`). Ctrl-C, or Stop on the Update tab, ends the current step cleanly
and starts no more; Ctrl-C again, or Quit now, ends the step at once, and kills it 30 s later if it
hasn't. An update refuses to start while another is running or a render run is live; one whose
process was killed is closed as failed by the next, once its processes are gone.

Its settings (each polled site on or off, the 5% guard, author lookups, screenshots, render on or off,
the top N favourites to render, how many prints to render per update, render workers, the memory cap per worker
and a one-off "retry failed pages", which the next update's render step uses, cleared once the render step has drawn) are saved in the local D1 as they are changed on the Update tab (`/admin/update`) under
`bun run dev`; without them the defaults apply. There, the Update tab draws the update as a board: one row per source
(factorioprints, codex, fprints, uploads) across the steps in order, Changes (at the source), Added (the one gate,
one source at a time), Authors, Screenshots, then the render run's stages Plan, Draw, Upload and Thumbnails, with a
Shared row for what is done once (screenshots' sizing and upload, the run's summary, Clean up and Search flags). Each
cell is a status and the update's own figures, live while a step runs (the render run writes its stages per source to
its row as it goes; the other steps' counts come from the log). Before an update the board shows what the last check
found; the seven steps above it open to one line on each and every figure it recorded; Start, Stop and the log are at
the top. `/admin` is the Overview: what the site has by source, what needs a look (open removal requests, upload
screenshots to approve, accounts being deleted), render coverage and past updates.

## Admin page (`/admin`, `/admin/pipeline`, `/admin/render`, `/admin/reports`)

`/admin` is the only private part of the site: backfill runs (`/admin/pipeline`) and render runs
(`/admin/render`), with pause, resume and stop, and removal requests to approve or reject
(`/admin/reports`, "Removal requests"). Render runs and updates happen on the machine that
renders and are recorded in its local D1, so `/admin/render` shows them under `bun run dev`, where
it can also start a batch, and `/admin` is the Overview and `/admin/update` runs updates (deployed,
`/admin` goes to `/admin/pipeline` and the Update tab is a 404). Two locks, both
required:

1. **Cloudflare Access** in front of `<domain>/admin*`, allowing only `ADMIN_EMAIL`. Alchemy
   creates it (`Cloudflare.Access.Application`, inline policy) when the stage has a
   custom domain and both `ACCESS_TEAM_DOMAIN` and `ADMIN_EMAIL` are set, and passes its AUD
   tag to the Worker as `ACCESS_AUD`.
2. **The Worker checks Access's JWT** (`Cf-Access-Jwt-Assertion`) on every /admin request,
   including form actions and `__data.json` (`src/hooks.server.ts`, `src/lib/server/admin/`):
   RS256 signature against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (cached
   per isolate), `iss`, `aud`, `exp`/`nbf`. If `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is empty,
   or the token is missing or invalid, /admin is a plain 404 and the reason goes to Workers Logs
   as `admin: denied …`. Under `bun run dev` /admin is open; under `bun run preview` it's a 404.

/admin responses are `cache-control: no-store, private` and `x-robots-tag: noindex`, and nothing
on the public site links there.

### Setup

1. **Zero Trust:** open Zero Trust in the Cloudflare dashboard. The first visit asks for a
   **team name**, which gives the team domain `<team>.cloudflareaccess.com`. The Free plan is
   enough.
2. **Login method:** Settings → Authentication. **One-time PIN** (a code emailed to you) is on
   by default and is enough.
3. **`.env`:** set `ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com` and
   `ADMIN_EMAIL=you@example.com`. For CI deploys, add both as secrets too: a deploy without them
   deletes the Access application and /admin becomes a 404 (it never opens up).
4. **Alchemy scopes:** re-run `bun alchemy profile edit --add Cloudflare` and add the
   **Cloudflare One / Zero Trust** group.
5. `bun run plan:prod`, then `bun run deploy:prod`. The plan shows `Admin`
   (`Cloudflare.Access.Application`, `example.com/admin*`) created before the Worker, and the
   output's `admin` is the page's URL.

### Checking it

- `curl -sI https://example.com/admin/pipeline` → `302` to `<team>.cloudflareaccess.com`.
- In a browser: the Access login, a PIN by email, then the page. Any other address gets
  Access's "not authorised" page.
- `curl -sI https://example.com/` → `200`, no Access.
- Workers Logs show `admin: denied …` if Access lets a request through but the Worker doesn't
  accept the token (wrong AUD or team domain).

### Without a custom domain

`alchemy.run.ts` creates the Access application only for a custom domain. On workers.dev, create
a self-hosted application by hand (Zero Trust → Access → Applications → Add → Self-hosted) with
hostname `factorio-prints-<stage>.<account-subdomain>.workers.dev`, path `admin*`, and an Allow
policy with an **Emails** rule for your address, then pass its **Application Audience (AUD)
Tag** to the Worker as `ACCESS_AUD` in `alchemy.run.ts`. Don't use the Worker's own "Enable
Cloudflare Access" toggle: it protects the whole Worker, not just /admin.

## Sign-in

People sign in with Discord, GitHub or Google (`src/lib/server/auth/`, `src/routes/auth/`): an OAuth
authorization-code flow with PKCE, run by the Worker. The site keeps the provider's user id and a
display name in D1 (`users`, `user_identities`, migration 0023), never an email address, password or
provider token. A session is a random token in an HttpOnly `__Host-` cookie, stored only as its
SHA-256 (`sessions`), for 30 days and extended when used; an account keeps at most 20, and signing in
again ends the browser's previous one. The daily cron Worker deletes expired sessions. Cached pages
never read the session (a cached route that asks throws): the header asks `/me` for the name, and a
readable `atlas_signed_in` cookie with no secret in it lets the page show "Account" before it has the
answer.

Each provider needs an app, its client id and secret in `.env`, and the redirect URL
`https://example.com/auth/<provider>/callback`. A provider without both values is off and its
button doesn't show; with none, nobody can sign in. The deploy binds each secret as a Worker
secret, and warns about each provider that's off.

- **Discord:** <https://discord.com/developers/applications> → New Application → OAuth2: copy the
  Client ID and reset the Client Secret, add the redirect. Scope used: `identify`. A new account is
  named after the Discord username.
- **GitHub:** Settings → Developer settings → OAuth Apps → New OAuth App: homepage
  `https://example.com`, callback URL as above; generate a client secret. No scopes (public
  profile). A new account is named after the GitHub login. An OAuth app takes one callback URL, so
  local development needs a second app with the local callback.
- **Google:** Google Cloud console → APIs & Services → OAuth consent screen (External; app name,
  support email, the site's domain), then Credentials → Create credentials → OAuth client ID → Web
  application, with the redirect as an authorised redirect URI. Scope used: `openid` only (the user
  id), which needs no verification by Google. Google names are often people's real names, so a new
  account is named "Engineer" and four random digits until its owner changes it.

All three get a PKCE challenge; GitHub and Discord accepting it hasn't been tried against the real
services yet, so check a first sign-in with each after setting the apps up.

Locally (`bun run dev`), `.env` is read too; register apps with
`http://127.0.0.1:5173/auth/<provider>/callback`, or use **Test account (vite dev only)** on the
sign-in page (`/auth/dev?as=<name>`), which is a 404 in every build.

Account names use only letters A–Z, digits, spaces, dots, dashes and underscores, start with a letter
or digit, and are unique ignoring case. They can't be a factorioprints author's name (compared after
stripping the author's name to the same characters), and a name given up by a rename or a deleted
account is held for 30 days, during which only its old account can take it back. To ban an account:
`UPDATE users SET banned_at = <unix ms>, ban_reason = '…' WHERE id = '…'`; its sessions stop at once
and it can't sign in again.

## Uploads

A signed-in account uploads a blueprint at `/upload` (string, title, Markdown description, optional
screenshot) and edits or deletes it at `/uploads/<id>` (linked from `/account`; the print page shows
its owner an Edit link from `/me`, never from the cached page). An upload is a print of the source
site `upload`, id `up-` and 10 random base62 characters (`src/lib/server/uploads/`, migration 0024).
Its record is kept only in the RAW bucket at `upload/<10 characters>.json`, as the pipeline's own text
for it (the same text the ingest archives there). It goes through the same gate and ingest as every
other source (`admitRecord`, `ingestRecord`), with the upload's own row in the same D1 batch as the
print's.

- New uploads need Turnstile (`TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`); every upload, edit and
  delete counts towards `UPLOAD_LIMIT` (10 per 60 s), and each account may upload 20 blueprints, save
  50 edits and add 10 screenshots per UTC day (`upload_quota`: reserved in one statement before
  anything is written, given back when the upload is refused, never reset by deleting an upload).
  Strings are at most 12 MB, screenshots 8 MB (PNG, JPEG, WebP or GIF, checked from the file's bytes).
- An upload goes on the site at once, unless it is over the Worker's size cap (512 KB of string or
  150,000 entities and tiles): then it waits as **processing** (`uploads.state`) for the next update,
  at most 5 per account. The update's fetch step admits it (`bun run uploads --stage <stage>`, the
  `uploads` source); one that fails 3 times is marked **failed**, and its owner sees why. An exact copy
  of a print already on the site is refused with a link to it. Every upload or edit that goes on the
  site bumps the page cache.
- A new display name goes onto the account's uploads (record, document, search row) as the account
  page saves it, for up to 10 s; the update's `uploads` source does any left. Until then the old name
  stays taken.
- Screenshots stay private in RAW (`upload-images/<16 hex>.<ext>`) until an admin approves them.
- Deleting an upload removes its source; the print goes unless another site also has it (then it
  stays at its URL, showing that site's record). Deleting an account deletes its uploads first, about
  15 s of them per request (each is about 20 D1 and R2 calls): the account page asks again until none
  are left, then deletes the account. Until then the account can't upload, edit or rename, and its
  owner, signing in again, lands on the page that carries on. A deletion its owner left part-way for
  over an hour is finished by the daily cron Worker (`src/lib/server/uploads/abandoned.ts`), at most
  200 uploads or 5 minutes a day, through the same path; so that Worker has the RAW, RENDERS and
  SCREENSHOTS buckets and the purge token too. If the next source of a print can't be
  re-ingested in the Worker when an upload goes, the print is purged and `meta.ingest_due` makes the
  next update run its ingest step, which admits that source again.
- A takedown of an upload's print (an approved removal request) also deletes its upload row and its
  pending screenshot, and blocks the content like any other takedown; the account's daily counts
  stay.

## Adding prints by link (`/admin/add`)

factoriobin.com has no listing, so its posts are never polled: an admin pastes a post's link at
`/admin/add`, looks it up, and adds it. The post is read through factoriobin's documented API
(`/post/<id>/info.json`, then the string on its CDN), once, with a User-Agent naming the site, and its
root node is the print even when the link names a book page (`src/lib/server/pipeline/factoriobin.ts`).
It goes through the same gate as every source (`addRecord` in `add-record.ts`: `admitRecord`, then
`ingestRecord`): a new print `fbin-<id>`, another source of the print it is an exact copy of, already
here, or refused (an approved removal, an unreadable string). The record is archived in RAW at
`factoriobin/<id>.json`. No image is copied: factoriobin has no player screenshots, only its own render.

- Deployed, the page adds in the Worker, within the same size cap as uploads (512 KB of string,
  150,000 entities and tiles); over it, the page says so. Responses are kept 10 minutes in the data
  centre's Cache API, so a look-up and an add read the post once.
- Under `vite dev`, the page runs `bun run add <link> --stage prod|local [--plan]` on the machine
  instead (no size cap), which also puts a print of its own into the record store. Prints added in the
  Worker reach the record store at the next update (`bun run records`, the `factoriobin` store site),
  and its render step draws their 2.0+ pages.

## Monitoring

- `/admin/pipeline`: the latest backfill runs, live progress, failures by reason, D1 rows and R2
  objects written, and run history.
- `bun run backfill:status --stage prod`: the same from the terminal.
- `/admin/render` under `bun run dev`: render runs on this machine, with progress, failures,
  uploads and pending deletions.
- Workers Logs in the Cloudflare dashboard for the Worker's own logs.

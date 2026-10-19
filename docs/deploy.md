# Deploying

The site deploys to your own Cloudflare account with [Alchemy](https://alchemy.run).
`alchemy.run.ts` defines one stack, `factorio-prints`, with two stages, `dev` and `prod`.

## What gets created

Each stage gets:

| Resource | Name                              | Binding   | Notes                                                           |
| -------- | --------------------------------- | --------- | --------------------------------------------------------------- |
| Worker   | `factorio-prints-<stage>`         |           | the SvelteKit app; preview URLs off                             |
| D1       | `factorio-prints-<stage>-db-<n>`  | `DB`      | migrations from `./migrations` applied on deploy                |
| R2       | `factorio-prints-<stage>-raw`     | `RAW`     | retained on destroy                                             |
| R2       | `factorio-prints-<stage>-renders` | `RENDERS` | retained on destroy                                             |
| Assets   | `.svelte-kit/cloudflare`          | `ASSETS`  | client files; honours the adapter's `.assetsignore`, `_headers` |
| Access   | `factorio-prints-<stage> admin`   |           | Zero Trust application on `<domain>/admin*`; see "Admin page"   |

Prod's D1 database is retained on destroy; dev's is deleted by `destroy:dev`. `<n>` is the D1
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
   the **Developer Platform** scopes, plus **DNS & Zones** if you use a custom domain, and
   **Cloudflare One / Zero Trust** for the admin page's Access application. Check with
   `bun alchemy profile show`.
4. **Copy `.env.example` to `.env`** and set what you need (all optional):

   ```sh
   SITE_DOMAIN_PROD=example.com
   SITE_DOMAIN_DEV=dev.example.com
   ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com
   ADMIN_EMAIL=you@example.com
   ALCHEMY_TELEMETRY_DISABLED=1
   ```

   A domain's zone must already be in the account. When `SITE_DOMAIN_<STAGE>` is set, the
   hostname is attached as a Worker custom domain and the `workers.dev` URL is turned off. Unset
   leaves domains alone (it never detaches one).

5. **For CI only**, an API token (My Profile → API Tokens → Custom), scoped to the account:
   - Account → Workers Scripts: Edit; D1: Edit; Workers R2 Storage: Edit;
     Secrets Store: Edit (the state store needs Edit, not Read); Account Settings: Read.
   - Optional: Account → Workers Tail: Read (for `alchemy logs`).
   - With a domain, scoped to that zone: Zone: Read; Workers Routes: Edit; DNS: Edit.
   - For the admin page: Account → Access: Apps and Policies: Edit.

   Store it as `CLOUDFLARE_API_TOKEN`, with `CLOUDFLARE_ACCOUNT_ID`, in your CI secrets, never in
   the repo. If a deploy reports a missing permission, add that group.

## Deploy

```sh
bun run plan:dev      # build, then show what would be created
bun run deploy:dev    # build, show the plan, ask for confirmation, then deploy
bun run plan:prod
bun run deploy:prod
```

The first plan or deploy asks to deploy Alchemy's **state store** (below), once per account.
`deploy:<stage>` then creates the D1 database and applies the migrations, creates both buckets,
deploys the Worker and prints its URL.

`bun run destroy:dev` removes the dev Worker and the dev D1 database. It keeps the buckets
(Alchemy forgets them). To re-attach kept resources on a later deploy, add `--adopt`. There is no
destroy script for prod.

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

The backfill streams every print from the GitHub mirror, at its current commit, into a stage's
D1 and R2, through wrangler's remote bindings. It needs `bunx wrangler login` and Node on PATH.

```sh
bun run backfill --stage dev --limit 200   # a sample first
bun run backfill --stage dev               # everything; resumable, re-runs skip unchanged prints
bun run backfill:status --stage dev
```

The account is taken from `CLOUDFLARE_ACCOUNT_ID`, or the only account `wrangler whoami` lists.
`--stage prod` asks for confirmation unless `--yes` is given. While it runs, the terminal and
`/admin/pipeline` show progress, failures and D1/R2 usage, and both can pause, resume or stop it.

## Swapping in a fresh D1 database

D1 databases are numbered per stage in `DATABASES` in `infra/databases.ts`.

1. Set `importTarget: 2` for the stage and deploy. Alchemy creates
   `factorio-prints-<stage>-db-2` and runs the migrations on it, but doesn't bind it. The
   site keeps using db-1.
2. Fill db-2, for example with `bun run backfill --stage <stage> --db 2`, and check it with
   `bunx wrangler d1 execute factorio-prints-<stage>-db-2 --remote --command "…"`.
3. Set `bound: 2` and remove `importTarget`, then deploy. The Worker is rebound to db-2 in one
   deploy.
4. In prod, db-1 is retained: Alchemy forgets it but it stays in Cloudflare as a rollback. To
   roll back, set `bound: 1` and deploy (add `--adopt` if Alchemy says the database isn't its
   own). In dev, db-1 is deleted by that deploy.

## Admin page (`/admin/pipeline`)

`/admin` is the only private part of the site: backfill progress, with pause, resume and stop.
Two locks, both required:

1. **Cloudflare Access** in front of `<domain>/admin*`, allowing only `ADMIN_EMAIL`. Alchemy
   creates it per stage (`Cloudflare.Access.Application`, inline policy) when the stage has a
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
5. `bun run plan:dev`, then `bun run deploy:dev`. The plan shows `Admin`
   (`Cloudflare.Access.Application`, `dev.example.com/admin*`) created before the Worker, and
   the output's `admin` is the page's URL.

### Checking it

- `curl -sI https://dev.example.com/admin/pipeline` → `302` to `<team>.cloudflareaccess.com`.
- In a browser: the Access login, a PIN by email, then the page. Any other address gets
  Access's "not authorised" page.
- `curl -sI https://dev.example.com/` → `200`, no Access.
- Workers Logs show `admin: denied …` if Access lets a request through but the Worker doesn't
  accept the token (wrong AUD or team domain).

### Without a custom domain

`alchemy.run.ts` creates the Access application only for a custom domain. On workers.dev, create
a self-hosted application by hand (Zero Trust → Access → Applications → Add → Self-hosted) with
hostname `factorio-prints-<stage>.<account-subdomain>.workers.dev`, path `admin*`, and an Allow
policy with an **Emails** rule for your address, then pass its **Application Audience (AUD)
Tag** to the Worker as `ACCESS_AUD` in `alchemy.run.ts`. Don't use the Worker's own "Enable
Cloudflare Access" toggle: it protects the whole Worker, not just /admin.

## Monitoring

- `/admin/pipeline`: the latest backfill runs, live progress, failures by reason, D1 rows and R2
  objects written, and run history.
- `bun run backfill:status --stage <stage>`: the same from the terminal.
- Workers Logs in the Cloudflare dashboard for the Worker's own logs.

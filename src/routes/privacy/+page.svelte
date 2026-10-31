<script lang="ts">
	import PageMeta from '#lib/components/PageMeta.svelte';

	/**
	 * What the site collects and keeps, in plain words. Static: no load, no cookies or locals, so it is safe
	 * to cache. Keep it in step with the code: page views (lib/server/views.ts), browser storage (app.html,
	 * lib/rate-unit.svelte.ts, SearchBox, lib/last-sign-in.ts, the print page's view fetch), screenshots (lib/screenshots.ts),
	 * removal requests (lib/reports.ts, lib/server/turnstile.ts), accounts (lib/server/auth/: providers'
	 * scopes, cookies, sessions, name holds) and uploads (lib/server/uploads/). Change the date when the
	 * text changes.
	 */
	const UPDATED = '30 October 2026';
	const REPO = 'https://github.com/jsmenzies/factorio-atlas';
	const link = 'text-amber-400 underline hover:text-amber-300';
</script>

<PageMeta
	title="Privacy · Blueprint Atlas"
	description="What Blueprint Atlas collects when you browse, what it keeps in your browser, and how to ask for a print or your details to be removed."
	canonical="/privacy"
/>

<article class="mx-auto max-w-2xl space-y-8 py-8 text-sm leading-relaxed text-stone-300 sm:text-base">
	<header class="space-y-2">
		<h1 class="text-2xl font-semibold text-stone-100">Privacy</h1>
		<p class="text-stone-500">Last updated {UPDATED}</p>
	</header>

	<section class="space-y-3">
		<p>
			Blueprint Atlas is a free, non-commercial hobby project for searching Factorio blueprints, run by one person. It is not affiliated
			with Wube Software or factorioprints.com. Its <a class={link} href={REPO}>source code is public</a>, so you can check what it does.
		</p>
		<p>
			There are no ads and no advertising or tracking cookies. You can browse without an account; you need one only to upload blueprints.
			This page says what the site does collect, and why.
		</p>
	</section>

	<section class="space-y-3">
		<h2 class="border-b border-stone-800 pb-2 text-lg font-semibold text-stone-100">When you browse</h2>
		<p>
			<strong class="font-medium text-stone-100">Page views.</strong> When you open a print, your browser tells the site once per tab
			that the print was viewed. The site records only which print it was: not your IP address, your browser or any cookie. These counts
			sort search results by “Popular this month” and are never shown on the site. Requests that announce themselves as bots aren’t counted.
		</p>
		<p>
			<strong class="font-medium text-stone-100">Cloudflare.</strong> The site runs on Cloudflare, which receives every request, including
			your IP address, in order to serve it. Cloudflare also:
		</p>
		<ul class="list-disc space-y-1 pl-5">
			<li>
				counts requests from each IP address over a few seconds or a minute, and turns away anyone sending too many. We don’t store these
				counts.
			</li>
			<li>
				may run a check in your browser (Bot Fight Mode) to tell people from automated traffic, and set a cookie,
				<code class="text-stone-100">cf_clearance</code>, that remembers your browser passed it.
			</li>
			<li>counts visits with Cloudflare Web Analytics, which doesn’t use cookies.</li>
			<li>keeps short-lived technical logs of requests to the site, which can include IP addresses, used to fix problems.</li>
		</ul>
		<p>
			Cloudflare handles this under <a class={link} href="https://www.cloudflare.com/privacypolicy/" rel="external">its own privacy policy</a>.
		</p>
		<p>
			<strong class="font-medium text-stone-100">Other sites.</strong> Screenshots, renders and icons come from the site’s own storage. A
			print added very recently may show its screenshot straight from Imgur until it has been copied, and pictures in an author’s description
			load from wherever the author put them. Neither is told which page you are on. The sites prints are copied from, such as factorioprints.com,
			and GitHub are contacted only if you follow a link to them.
		</p>
	</section>

	<section class="space-y-3">
		<h2 class="border-b border-stone-800 pb-2 text-lg font-semibold text-stone-100">In your browser</h2>
		<p>
			Unless you sign in, the site itself sets no cookies; the only one you may get is Cloudflare’s bot check above. Signing in adds the
			cookies described under “Accounts and uploads”. The site keeps four small things in your browser’s own storage, which are never sent
			to the site:
		</p>
		<ul class="list-disc space-y-1 pl-5">
			<li><code class="text-stone-100">atlas.rate</code> (local storage): whether you show rates per second or per minute.</li>
			<li><code class="text-stone-100">atlas.picker.tab</code> (local storage): the tab you last opened in the search box’s item menu.</li>
			<li>
				<code class="text-stone-100">atlas.lastSignIn</code> (local storage): which service you last signed in with, so the sign-in page can
				mark it. It stays when you sign out and goes when you delete your account.
			</li>
			<li>
				<code class="text-stone-100">viewed:</code> and a print’s id (session storage, gone when you close the tab): so each print counts one
				view per tab.
			</li>
		</ul>
		<p>You can clear them at any time in your browser’s settings; the site works the same without them.</p>
	</section>

	<section class="space-y-3">
		<h2 class="border-b border-stone-800 pb-2 text-lg font-semibold text-stone-100">Blueprints, authors and screenshots</h2>
		<p>
			Most blueprints here are copied from <a class={link} href="https://factorioprints.com" rel="external">factorioprints.com</a>, where
			their authors shared them publicly, and each one links back to its original. Authors are named as factorioprints.com names them: from
			the print itself, or from the display name on their factorioprints account, which is often the name on their Google account. The rest
			are uploaded here by their authors, under their display name here (see “Accounts and uploads”).
		</p>
		<p>
			Screenshots of copied prints are copies of the images authors uploaded to Imgur for them, and a print deleted from factorioprints.com
			may still be here. To have a screenshot or a print removed, ask as below; once removed, it isn’t copied here again. An uploaded print’s
			screenshot is the image its uploader sent with it.
		</p>
	</section>

	<section class="space-y-3">
		<h2 class="border-b border-stone-800 pb-2 text-lg font-semibold text-stone-100">Removal requests</h2>
		<p>
			Every print’s page has a “Request removal” link. The form asks why, and optionally for more details and a way to reach you, such as
			an email address or Discord name. The site stores your answers with the print and the time, not your IP address. A person reads every
			request; nothing is removed automatically.
		</p>
		<p>
			The form uses Cloudflare Turnstile to check that it was sent by a person: it runs in your browser, and the site passes your IP
			address to Cloudflare with the check.
		</p>
		<p>
			Your contact details and what you wrote are deleted 30 days after the request is decided; the reason you picked and the decision are
			kept. If a print is removed, its blueprint, screenshot and renders are deleted here and it won’t be copied again.
		</p>
	</section>

	<section class="space-y-3">
		<h2 class="border-b border-stone-800 pb-2 text-lg font-semibold text-stone-100">Accounts and uploads</h2>
		<p>
			<strong class="font-medium text-stone-100">Signing in.</strong> You sign in with Discord, GitHub or Google; the site has no passwords
			of its own. That service tells the site only your account’s id there, and for Discord and GitHub your user name, which the site
			suggests as your display name. Google’s accounts get a made-up name such as “Engineer 4821” instead. The site never asks for or
			stores your email address, and keeps no access to your account at that service. The service itself knows that you signed in to
			Blueprint Atlas, under its own privacy policy.
		</p>
		<p>
			<strong class="font-medium text-stone-100">What the site keeps.</strong> Your account’s id at the service you used, your display name
			(which you can change) and when the account was made. Your display name is shown with every blueprint you upload. When you give up a
			name, by changing it or deleting your account, the site keeps it with your account’s id for 30 days so that nobody else can take it
			straight away.
		</p>
		<p>
			<strong class="font-medium text-stone-100">Cookies.</strong> Signing in sets
			<code class="text-stone-100">__Host-atlas_session</code>, which keeps you signed in for 30 days, renewed when you come back. It holds a random
			key; the site stores only a scrambled form of it (a hash), with your account and when it expires. Beside it,
			<code class="text-stone-100">atlas_signed_in</code> holds nothing but “1”, so pages can show “Account” rather than “Sign in” before they
			have asked who you are. While you sign in, <code class="text-stone-100">__Host-atlas_oauth</code> remembers the sign-in for up to
			ten minutes, then goes. Signing out deletes all of them.
		</p>
		<p>
			<strong class="font-medium text-stone-100">Uploads.</strong> A blueprint you upload (its string, title and description) is shown to
			everyone with your display name, as soon as you send it. A screenshot you add is kept private until a person has checked it, and is
			shown only if they approve it. The site counts how many uploads, edits and screenshots each account sends per day, to keep a daily
			limit, and deletes those counts after a day or two. The upload form uses Cloudflare Turnstile, as removal requests do.
		</p>
		<p>
			<strong class="font-medium text-stone-100">Deleting.</strong> You can delete any of your uploads, or your whole account, from your
			account page. Deleting an upload deletes its blueprint, screenshot and renders here, unless the same blueprint is also on another
			site the Atlas copies from, in which case only your copy and your name go. Deleting your account deletes all your uploads in the same
			way, your sign-ins, your sessions and your daily counts; only the 30-day hold on your display name stays until it ends. A screenshot
			another upload also uses stays with that upload, without your account. With many uploads, deleting them takes a few steps: keep the
			page open until it signs you out, or sign in again later to let it finish.
		</p>
	</section>

	<section class="space-y-3">
		<h2 class="border-b border-stone-800 pb-2 text-lg font-semibold text-stone-100">Seeing, correcting or deleting your information</h2>
		<p>
			Anyone can ask to see, correct or delete what the site holds about them. If you have an account, your account page shows your display
			name and uploads, and lets you change or delete them.
		</p>
		<ul class="list-disc space-y-1 pl-5">
			<li>
				About a print or its screenshot, including the author name shown on it: use “Request removal” on that print’s page, and say what you
				want in the details.
			</li>
			<li>
				Anything else, or questions about this page: open an issue in the <a class={link} href="{REPO}/issues">GitHub repository</a>.
				Issues are public, so please don’t post personal details there.
			</li>
		</ul>
		<p>If this page changes, the date at the top changes too.</p>
	</section>
</article>

<script lang="ts" module>
	export type TabId = 'overview' | 'pages' | 'produces' | 'inputs' | 'entities' | 'recipes' | 'about';
	export interface Tab {
		id: TabId;
		label: string;
		/** Shown small after the label: how many pages, items, entity kinds… */
		count?: number;
	}
</script>

<script lang="ts">
	/**
	 * The print page's tab bar, under the header. Each tab's panel is `panel-<id>`, labelled by
	 * `tab-<id>`. ←/→, Home and End move between tabs (the ARIA tabs pattern); on phones the row
	 * scrolls sideways and keeps the chosen tab in view.
	 */
	let { tabs, active, onselect }: { tabs: Tab[]; active: TabId; onselect: (id: TabId) => void } = $props();

	let buttons = $state<HTMLButtonElement[]>([]);
	const KEYS: Record<string, (i: number) => number> = {
		ArrowRight: (i) => i + 1,
		ArrowLeft: (i) => i - 1,
		Home: () => 0,
		End: () => tabs.length - 1
	};
	const move = (e: KeyboardEvent, i: number) => {
		const step = KEYS[e.key];
		if (!step) return;
		e.preventDefault();
		const j = (step(i) + tabs.length) % tabs.length;
		onselect(tabs[j].id);
		buttons[j]?.focus();
	};
	// Sideways only: scrollIntoView would also scroll the window to the tab bar.
	let bar = $state<HTMLDivElement>();
	$effect(() => {
		const b = buttons[tabs.findIndex((t) => t.id === active)];
		if (!bar || !b) return;
		if (b.offsetLeft < bar.scrollLeft) bar.scrollLeft = b.offsetLeft;
		else if (b.offsetLeft + b.offsetWidth > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = b.offsetLeft + b.offsetWidth - bar.clientWidth;
	});
</script>

<div bind:this={bar} role="tablist" aria-label="About this print" class="relative flex overflow-x-auto shadow-[inset_0_-1px_0_var(--color-stone-800)] [scrollbar-width:none]">
	{#each tabs as t, i (t.id)}
		{@const on = t.id === active}
		<button
			bind:this={buttons[i]}
			type="button"
			role="tab"
			id="tab-{t.id}"
			aria-selected={on}
			aria-controls="panel-{t.id}"
			tabindex={on ? 0 : -1}
			onclick={() => onselect(t.id)}
			onkeydown={(e) => move(e, i)}
			class="shrink-0 border-b-2 px-4 py-3 whitespace-nowrap {on
				? 'border-amber-500 font-semibold text-stone-50'
				: 'border-transparent text-stone-400 hover:border-stone-600 hover:text-stone-200'}"
		>
			{t.label}{#if t.count}<span class="ml-1.5 text-xs font-normal text-stone-500">{t.count.toLocaleString()}</span>{/if}
		</button>
	{/each}
</div>

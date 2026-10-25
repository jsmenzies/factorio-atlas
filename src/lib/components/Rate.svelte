<script lang="ts">
	import { formatRate } from '#lib/format.js';

	/**
	 * A rate (items/s) in both units. CSS shows the one `<html data-rate>` names, which app.html sets
	 * from the visitor's choice before the page draws, so cached pages never flash the other unit.
	 */
	let { value }: { value: number } = $props();
</script>

<span class="rate-s">{formatRate(value, 's')}</span><span class="rate-min">{formatRate(value, 'min')}</span>

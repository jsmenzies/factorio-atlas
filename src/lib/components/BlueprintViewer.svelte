<script lang="ts">
	import { untrack } from 'svelte';
	import type { Attachment } from 'svelte/attachments';
	import Icon from '#lib/components/Icon.svelte';
	import { describe } from '#lib/viewer/describe.js';
	import { footprint } from '#lib/viewer/geometry.js';
	import { buildInspector, type Inspector } from '#lib/viewer/inspect.js';
	import { pickLevel, tileFile, tileRect, visibleTiles, type RenderSidecar } from '#lib/viewer/game-render.js';
	import type { CompactPage, TooltipData } from '#lib/viewer/types.js';

	/**
	 * A page's game render (made offline by fpsr): the overview, then the sharpest tile level the
	 * zoom needs. `page` is the same page's entity data, in the render's world coordinates, for
	 * hover tooltips and outlines of modded entities fpsr can't draw. `tooltip` has the icons,
	 * English names and module slot counts for the names the page uses.
	 *
	 * `full` is the full-screen page's look: the controls float over the render (zoom bar, minimap,
	 * key hints) and the keys work anywhere on the page. `onexit` is what Esc does there.
	 */
	let {
		page,
		render,
		tooltip = null,
		full = false,
		onexit
	}: {
		page: CompactPage;
		render: { sidecar: RenderSidecar; base: string };
		tooltip?: TooltipData | null;
		full?: boolean;
		onexit?: () => void;
	} = $props();

	const NO_ICONS = { base: '', of: {} };
	const icons = $derived(tooltip?.icons ?? NO_ICONS);
	/** English name where the game has one, else the prototype name. */
	const labelOf = (name: string) => tooltip?.labels[name] ?? name;

	let canvas = $state<HTMLCanvasElement>();
	let inspector = $state.raw<Inspector | null>(null);
	let hovered = $state<number | null>(null);
	let tip = $state.raw({ x: 0, y: 0 });
	let zoomPct = $state(100);
	let failed = $state(false);
	let level = $state<number | null>(null);
	/** Whether the view is still the fitted one (the Fit button shows it). */
	let atFit = $state(true);
	const unknownNames = $derived(new Set(Object.keys(render.sidecar.stats.unknown)));

	/** screen = world × s + t, in CSS pixels. Not reactive: drawing is imperative. */
	const view = { s: 16, tx: 0, ty: 0 };
	const size = { w: 0, h: 0, dpr: 1 };
	let needsFit = true;
	let frame = 0;

	const MIN_S = 0.3;
	const MAX_S = 160;

	const requestDraw = () => {
		if (!frame) frame = requestAnimationFrame(draw);
	};

	const fit = () => {
		if (!size.w || !size.h) return;
		// The entities, not the render's frame: fpsr's frame also holds the snap-grid box.
		const { minX, minY, maxX, maxY } = render.sidecar.frame;
		const { x0, y0, x1, y1 } = inspector?.bounds ?? { x0: minX, y0: minY, x1: maxX, y1: maxY };
		const bw = Math.max(4, x1 - x0 + 2);
		const bh = Math.max(4, y1 - y0 + 2);
		// Full screen keeps the fitted render clear of the floating header (top) and zoom bar (bottom).
		const top = full && size.h > 400 ? 76 : 0;
		const bottom = full && size.h > 400 ? 64 : 0;
		const h = size.h - top - bottom;
		view.s = Math.min(MAX_S, Math.max(MIN_S, Math.min(size.w / bw, h / bh)));
		view.tx = size.w / 2 - ((x0 + x1) / 2) * view.s;
		view.ty = top + h / 2 - ((y0 + y1) / 2) * view.s;
		needsFit = false;
		atFit = true;
		zoomPct = Math.round(view.s * 100) / 100;
		requestDraw();
	};

	const zoomAt = (px: number, py: number, factor: number) => {
		const s = Math.min(MAX_S, Math.max(MIN_S, view.s * factor));
		const k = s / view.s;
		view.tx = px - (px - view.tx) * k;
		view.ty = py - (py - view.ty) * k;
		view.s = s;
		atFit = false;
		zoomPct = Math.round(view.s * 100) / 100;
		requestDraw();
	};

	// Render images by URL; 'error' marks a failed load so it isn't retried every frame. Every image's
	// name changes with its pixels (tiles by hash, the overview by the render's stamp), so URLs never
	// need a version.
	let images = new Map<string, HTMLImageElement | 'loading' | 'error'>();
	const image = (file: string, overview = false): HTMLImageElement | null => {
		const r = render;
		const url = `${r.base}/${file}`;
		const got = images.get(url);
		if (got instanceof HTMLImageElement) return got;
		if (got) return null;
		if (images.size > 400) for (const k of [...images.keys()].slice(0, 100)) images.delete(k);
		const img = new Image();
		images.set(url, 'loading');
		img.onload = () => {
			images.set(url, img);
			requestDraw();
		};
		img.onerror = () => {
			images.set(url, 'error');
			if (overview) failed = true;
		};
		img.src = url;
		return null;
	};

	// New page or render: fresh images, hover geometry and fit.
	$effect(() => {
		const p = page;
		void render;
		untrack(() => {
			images = new Map();
			failed = false;
			inspector = buildInspector(p);
			hovered = null;
			needsFit = true;
			fit();
		});
	});

	$effect(() => {
		// Redraw when the hover changes, or the minimap comes or goes.
		void hovered;
		void mapCanvas;
		requestDraw();
	});

	/** Keeps the canvas at the container's size in device pixels; the first fit waits for a size. */
	const fitToContainer: Attachment<HTMLDivElement> = (el) => {
		const ro = new ResizeObserver(() => {
			const cv = canvas;
			if (!cv) return;
			const r = el.getBoundingClientRect();
			size.w = r.width;
			size.h = r.height;
			size.dpr = window.devicePixelRatio || 1;
			cv.width = Math.round(r.width * size.dpr);
			cv.height = Math.round(r.height * size.dpr);
			if (needsFit) fit();
			requestDraw();
		});
		ro.observe(el);
		return () => ro.disconnect();
	};

	/** Wheel zoom, non-passive (Svelte's `onwheel` is passive) so the page doesn't scroll while zooming. */
	const wheelZoom: Attachment<HTMLCanvasElement> = (cv) => {
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const r = cv.getBoundingClientRect();
			const unit = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 1 : 0.0015;
			zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * unit * (e.ctrlKey ? 4 : 1)));
		};
		cv.addEventListener('wheel', onWheel, { passive: false });
		return () => {
			cv.removeEventListener('wheel', onWheel);
			// The canvas is going: drop any frame still queued for it.
			if (frame) cancelAnimationFrame(frame);
			frame = 0;
		};
	};

	function draw() {
		frame = 0;
		const cv = canvas;
		const ins = inspector;
		if (!cv) return;
		const ctx = cv.getContext('2d');
		if (!ctx) return;
		const { w, h, dpr } = size;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.fillStyle = '#0c0a09';
		ctx.fillRect(0, 0, w, h);
		const { s, tx, ty } = view;
		const wx0 = -tx / s;
		const wy0 = -ty / s;
		const wx1 = (w - tx) / s;
		const wy1 = (h - ty) / s;
		drawRender(ctx, render.sidecar, wx0, wy0, wx1, wy1);
		drawMap(wx0, wy0, wx1, wy1);
		if (!ins) return;
		ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * tx, dpr * ty);
		ctx.globalAlpha = 1;
		ctx.setLineDash([]);

		// fpsr draws entities it has no sprites for (mods) as a 1×1 marker; show their footprint.
		if (unknownNames.size) {
			ctx.strokeStyle = '#f97316';
			ctx.lineWidth = Math.max(0.04, 1.5 / s);
			ctx.setLineDash([0.25, 0.15]);
			for (const e of ins.geo) {
				if (!unknownNames.has(e.name) || e.x < wx0 - 8 || e.x > wx1 + 8 || e.y < wy0 - 8 || e.y > wy1 + 8) continue;
				const [fw, fh] = footprint(e.w, e.h, e.dir);
				ctx.strokeRect(e.x - fw / 2, e.y - fh / 2, fw, fh);
			}
			ctx.setLineDash([]);
		}

		// Hover outline.
		if (hovered !== null) {
			const e = ins.geo[hovered];
			const [fw, fh] = footprint(e.w, e.h, e.dir);
			ctx.strokeStyle = '#fbbf24';
			ctx.lineWidth = Math.max(0.06, 2 / s);
			ctx.strokeRect(e.x - fw / 2, e.y - fh / 2, fw, fh);
		}
	}

	/**
	 * The overview (always loaded, so panning never shows holes), then the sharpest tile level the
	 * zoom needs. Under a level the overview fills in only tiles still loading: elsewhere its blur
	 * would show through the tiles' transparent pixels. Edges snap to device pixels so tiles don't seam.
	 */
	function drawRender(ctx: CanvasRenderingContext2D, sc: RenderSidecar, wx0: number, wy0: number, wx1: number, wy1: number) {
		const { s, tx, ty } = view;
		const { dpr } = size;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = 'high';
		/** Draw `img` (or its source rect `src`) over the world rect x, y, w, h. */
		const blit = (img: HTMLImageElement, x: number, y: number, w: number, h: number, src?: [number, number, number, number]) => {
			const X0 = Math.round(dpr * (x * s + tx));
			const Y0 = Math.round(dpr * (y * s + ty));
			const X1 = Math.round(dpr * ((x + w) * s + tx));
			const Y1 = Math.round(dpr * ((y + h) * s + ty));
			if (src) ctx.drawImage(img, src[0], src[1], src[2], src[3], X0, Y0, X1 - X0, Y1 - Y0);
			else ctx.drawImage(img, X0, Y0, X1 - X0, Y1 - Y0);
		};
		const { frame, overview } = sc;
		const ov = image(sc.overview.file, true);
		const lv = pickLevel(sc, s * dpr);
		level = lv?.ppt ?? null;
		if (!lv) {
			if (ov) blit(ov, frame.minX, frame.minY, overview.width / overview.ppt, overview.height / overview.ppt);
			return;
		}
		for (const [c, r] of visibleTiles(sc, lv, wx0, wy0, wx1, wy1)) {
			// Transparent tiles have no file, and the overview shows nothing there either.
			const file = tileFile(lv, c, r);
			if (!file) continue;
			const t = tileRect(sc, lv, c, r);
			const img = image(file);
			if (img) blit(img, t.x, t.y, t.w, t.h);
			else if (ov) {
				const k = overview.ppt;
				blit(ov, t.x, t.y, t.w, t.h, [(t.x - frame.minX) * k, (t.y - frame.minY) * k, t.w * k, t.h * k]);
			}
		}
	}

	// --- minimap (full screen): the overview with the view's outline; click or drag to move there
	let mapCanvas = $state<HTMLCanvasElement>();
	let showMap = $state(true);
	const MAP_W = 180;
	const MAP_H = 110;
	/** The minimap's size in CSS pixels and its CSS pixels per world tile. */
	const map = $derived.by(() => {
		const o = render.sidecar.overview;
		const k = Math.min(MAP_W / o.width, MAP_H / o.height);
		return { w: Math.round(o.width * k), h: Math.round(o.height * k), ppt: k * o.ppt };
	});

	function drawMap(wx0: number, wy0: number, wx1: number, wy1: number) {
		const cv = mapCanvas;
		if (!cv) return;
		const ctx = cv.getContext('2d');
		if (!ctx) return;
		const { dpr } = size;
		const { w, h, ppt } = map;
		if (cv.width !== Math.round(w * dpr)) cv.width = Math.round(w * dpr);
		if (cv.height !== Math.round(h * dpr)) cv.height = Math.round(h * dpr);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, w, h);
		const ov = images.get(`${render.base}/${render.sidecar.overview.file}`);
		if (ov instanceof HTMLImageElement) {
			ctx.imageSmoothingQuality = 'high';
			ctx.drawImage(ov, 0, 0, w, h);
		}
		const { minX, minY } = render.sidecar.frame;
		const x0 = Math.max(1, (wx0 - minX) * ppt);
		const y0 = Math.max(1, (wy0 - minY) * ppt);
		const x1 = Math.min(w - 1, (wx1 - minX) * ppt);
		const y1 = Math.min(h - 1, (wy1 - minY) * ppt);
		if (x1 <= x0 || y1 <= y0) return;
		ctx.strokeStyle = '#fbbf24';
		ctx.lineWidth = 1.5;
		ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
	}

	let mapDrag = false;
	const mapMove = (e: PointerEvent) => {
		const r = mapCanvas!.getBoundingClientRect();
		const { minX, minY } = render.sidecar.frame;
		view.tx = size.w / 2 - (minX + (e.clientX - r.left) / map.ppt) * view.s;
		view.ty = size.h / 2 - (minY + (e.clientY - r.top) / map.ppt) * view.s;
		atFit = false;
		requestDraw();
	};

	// --- pointer interaction: drag to pan, pinch to zoom, hover/tap to inspect
	const pointers = new Map<number, { x: number; y: number }>();
	let moved = 0;
	let pinch: { d: number; s: number; wx: number; wy: number } | null = null;

	const local = (e: PointerEvent | MouseEvent) => {
		const r = canvas!.getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	};

	const pick = (px: number, py: number) => {
		if (!inspector) return;
		const wx = Math.floor((px - view.tx) / view.s);
		const wy = Math.floor((py - view.ty) / view.s);
		const key = (wx + 1048576) * 2097152 + (wy + 1048576);
		hovered = inspector.hit.get(key) ?? null;
		tip = { x: px, y: py };
	};

	const pinchState = () => {
		const [a, b] = [...pointers.values()];
		const mx = (a.x + b.x) / 2;
		const my = (a.y + b.y) / 2;
		return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx, my };
	};

	const onpointerdown = (e: PointerEvent) => {
		canvas!.setPointerCapture(e.pointerId);
		pointers.set(e.pointerId, local(e));
		moved = 0;
		if (pointers.size === 2) {
			const p = pinchState();
			pinch = { d: p.d, s: view.s, wx: (p.mx - view.tx) / view.s, wy: (p.my - view.ty) / view.s };
		}
	};
	const onpointermove = (e: PointerEvent) => {
		const pos = local(e);
		const prev = pointers.get(e.pointerId);
		if (!prev) {
			if (e.pointerType === 'mouse') pick(pos.x, pos.y);
			return;
		}
		pointers.set(e.pointerId, pos);
		if (pointers.size === 1) {
			view.tx += pos.x - prev.x;
			view.ty += pos.y - prev.y;
			moved += Math.abs(pos.x - prev.x) + Math.abs(pos.y - prev.y);
			if (moved > 4) {
				hovered = null;
				atFit = false;
			}
			requestDraw();
		} else if (pointers.size === 2 && pinch) {
			const p = pinchState();
			view.s = Math.min(MAX_S, Math.max(MIN_S, (pinch.s * p.d) / pinch.d));
			view.tx = p.mx - pinch.wx * view.s;
			view.ty = p.my - pinch.wy * view.s;
			atFit = false;
			zoomPct = Math.round(view.s * 100) / 100;
			moved += 10;
			requestDraw();
		}
	};
	const onpointerup = (e: PointerEvent) => {
		const pos = local(e);
		pointers.delete(e.pointerId);
		if (pointers.size < 2) pinch = null;
		if (moved < 5) pick(pos.x, pos.y);
	};
	const onpointerleave = (e: PointerEvent) => {
		if (e.pointerType === 'mouse' && !pointers.size) hovered = null;
	};
	const onkeydown = (e: KeyboardEvent) => {
		const step = 60;
		if (e.key === 'f') fit();
		else if (e.key === '+' || e.key === '=') zoomAt(size.w / 2, size.h / 2, 1.25);
		else if (e.key === '-') zoomAt(size.w / 2, size.h / 2, 0.8);
		else if (e.key === 'ArrowLeft') view.tx += step;
		else if (e.key === 'ArrowRight') view.tx -= step;
		else if (e.key === 'ArrowUp') view.ty += step;
		else if (e.key === 'ArrowDown') view.ty -= step;
		else if (e.key === 'Escape' && onexit) onexit();
		else return;
		e.preventDefault();
		if (e.key.startsWith('Arrow')) atFit = false;
		requestDraw();
	};
	/** Full screen: the keys work wherever focus is, except in form fields and dialogs. */
	const onwindowkey = (e: KeyboardEvent) => {
		const t = e.target;
		if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
		if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
		if (document.querySelector('dialog[open]')) return;
		onkeydown(e);
	};

	const info = $derived(
		inspector && hovered !== null
			? describe(page, inspector.geo, hovered, {
					shapes: inspector.shapes,
					undergroundPartner: inspector.undergroundPartner,
					pipes: inspector.pipes
				})
			: null
	);
</script>

<svelte:window onkeydown={full ? onwindowkey : undefined} />

{#snippet zoomButton(label: string, title: string, onclick: () => void, pressed?: boolean)}
	<button
		class="rounded-md px-2.5 py-1 hover:bg-stone-800 hover:text-stone-100 {pressed ? 'bg-stone-700/80 text-stone-100' : ''}"
		aria-pressed={pressed}
		{title}
		{onclick}>{label}</button
	>
{/snippet}

<div class="flex h-full min-h-0 flex-col">
	{#if !full}
		<div class="flex flex-wrap items-center gap-2 border-b border-stone-800 bg-stone-900/80 px-3 py-1.5 text-xs">
			{#if failed}
				<span class="text-red-300">render failed to load</span>
			{/if}
			{#if unknownNames.size}
				<span class="text-orange-300" title={[...unknownNames].join(', ')}>{unknownNames.size} modded types outlined</span>
			{/if}
			<span class="text-stone-500" title="Rendered offline by fpsr {render.sidecar.fpsr} for Factorio {render.sidecar.assets.gameVersion}"
				>{level ? `${level} px/tile tiles` : 'overview'}</span
			>
			<span class="mx-1 h-4 w-px bg-stone-700"></span>
			<button class="rounded bg-stone-800 px-2 py-0.5 hover:bg-stone-700" onclick={fit} title="Fit to view (F)">Fit</button>
			<button class="rounded bg-stone-800 px-2 py-0.5 hover:bg-stone-700" onclick={() => zoomAt(size.w / 2, size.h / 2, 1.25)} title="Zoom in (+)"
				>+</button
			>
			<button class="rounded bg-stone-800 px-2 py-0.5 hover:bg-stone-700" onclick={() => zoomAt(size.w / 2, size.h / 2, 0.8)} title="Zoom out (−)"
				>−</button
			>
			<span class="text-stone-500">{zoomPct} px/tile</span>
			<span class="ml-auto text-stone-500">{page.entities.length.toLocaleString()} entities</span>
		</div>
	{/if}
	<div {@attach fitToContainer} class="relative min-h-0 flex-1 overflow-hidden">
		<canvas
			bind:this={canvas}
			{@attach wheelZoom}
			class="absolute inset-0 h-full w-full cursor-grab touch-none outline-none active:cursor-grabbing"
			tabindex="0"
			aria-label="Blueprint render. Drag to pan, scroll or pinch to zoom, F to fit."
			{onpointerdown}
			{onpointermove}
			{onpointerup}
			onpointercancel={onpointerup}
			{onpointerleave}
			onkeydown={full ? undefined : onkeydown}
		></canvas>
		{#if full}
			<div class="pointer-events-none absolute inset-x-3 bottom-3 flex items-end justify-center gap-3 sm:inset-x-5 sm:bottom-5 sm:justify-between">
				<!-- Hints sit on the render, so a faint backing keeps them readable over busy builds. -->
				<div class="hidden min-w-0 flex-1 space-y-1 text-xs text-stone-500 sm:block [&>p]:w-fit [&>p]:rounded [&>p]:bg-stone-950/70 [&>p]:px-1.5 [&>p]:py-0.5">
					{#if failed}<p class="text-red-300">The render failed to load.</p>{/if}
					{#if unknownNames.size}
						<p class="pointer-events-auto text-orange-300" title={[...unknownNames].join(', ')}>
							{unknownNames.size} modded {unknownNames.size === 1 ? 'type' : 'types'} outlined
						</p>
					{/if}
					<p>Scroll to zoom · drag to pan · F to fit{onexit ? ' · Esc to go back' : ''}</p>
				</div>
				<div
					class="pointer-events-auto flex shrink-0 items-center gap-0.5 rounded-lg border border-stone-700 bg-stone-900/90 p-1 text-sm text-stone-300 shadow-lg backdrop-blur"
					role="toolbar"
					aria-label="Zoom"
				>
					{@render zoomButton('Fit', 'Fit to view (F)', fit, atFit)}
					{@render zoomButton('−', 'Zoom out (−)', () => zoomAt(size.w / 2, size.h / 2, 0.8))}
					<span
						class="w-24 text-center font-mono text-xs text-stone-300 tabular-nums"
						title="{level ? `Drawing ${level} px/tile tiles` : 'Drawing the overview'}; rendered offline by fpsr {render.sidecar
							.fpsr} for Factorio {render.sidecar.assets.gameVersion}">{zoomPct < 10 ? zoomPct.toFixed(2) : zoomPct.toFixed(1)} px/tile</span
					>
					{@render zoomButton('+', 'Zoom in (+)', () => zoomAt(size.w / 2, size.h / 2, 1.25))}
					<!-- Phones have no room for the minimap, so no switch for it either. -->
					<span class="hidden sm:contents">
						<span class="mx-1 h-5 w-px bg-stone-700"></span>
						{@render zoomButton('Overview', showMap ? 'Hide the minimap' : 'Show the minimap', () => (showMap = !showMap), showMap)}
					</span>
				</div>
				<div class="hidden flex-1 justify-end sm:flex">
					{#if showMap}
						<canvas
							bind:this={mapCanvas}
							class="pointer-events-auto hidden cursor-pointer touch-none rounded-md border border-stone-700 bg-stone-950/90 shadow-lg sm:block"
							style:width="{map.w}px"
							style:height="{map.h}px"
							aria-label="Minimap. Click or drag to move the view."
							onpointerdown={(e) => {
								mapCanvas!.setPointerCapture(e.pointerId);
								mapDrag = true;
								mapMove(e);
							}}
							onpointermove={(e) => mapDrag && mapMove(e)}
							onpointerup={() => (mapDrag = false)}
							onpointercancel={() => (mapDrag = false)}
						></canvas>
					{/if}
				</div>
			</div>
		{/if}
		{#if info}
			{@const slots = tooltip?.slots[info.title] ?? 0}
			{@const filled = info.modules.reduce((n, m) => n + m.count, 0)}
			<div
				class="pointer-events-none absolute z-10 w-72 rounded border border-stone-700 bg-stone-900/95 px-2.5 py-2 text-xs shadow-lg"
				style:left="{Math.max(4, Math.min(tip.x + 14, size.w - 296))}px"
				style:top="{Math.max(4, Math.min(tip.y + 14, size.h - 240))}px"
			>
				<div class="mb-1.5 flex items-center gap-2">
					<Icon {icons} kind="entity" name={info.proto} label="" size={28} />
					<div class="flex min-w-0 items-center gap-1 font-semibold text-amber-300">
						<span class="truncate">{labelOf(info.proto)}</span>
						{#if info.quality}<Icon {icons} kind="quality" name={info.quality} label={info.quality} size={14} />{/if}
					</div>
				</div>
				<dl class="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
					{#if info.recipe}
						<dt class="text-stone-500">recipe</dt>
						<dd class="flex min-w-0 items-center gap-1 text-stone-200">
							<Icon {icons} kind="recipe" name={info.recipe.name} label="" size={18} />
							<span class="truncate">{labelOf(info.recipe.name)}</span>
							{#if info.recipe.quality}<Icon {icons} kind="quality" name={info.recipe.quality} label={info.recipe.quality} size={12} />{/if}
						</dd>
					{/if}
					{#if slots || info.modules.length}
						<dt class="text-stone-500">modules</dt>
						<dd class="flex flex-wrap items-center gap-0.5">
							{#each info.modules as m, i (i)}
								{#each { length: m.count }, k (k)}
									<span class="relative inline-grid size-6 place-items-center rounded-sm bg-stone-800 ring-1 ring-stone-700" title={labelOf(m.name)}>
										<Icon {icons} name={m.name} label={labelOf(m.name)} size={20} />
										{#if m.quality}
											<span class="absolute -bottom-0.5 -left-0.5"><Icon {icons} kind="quality" name={m.quality} label={m.quality} size={10} /></span>
										{/if}
									</span>
								{/each}
							{/each}
							{#each { length: Math.max(0, slots - filled) }, k (k)}
								<span class="inline-block size-6 rounded-sm bg-stone-950 ring-1 ring-stone-700" title="empty slot"></span>
							{/each}
							{#if slots}<span class="ml-1 text-stone-500">{filled} of {slots}</span>{/if}
						</dd>
					{/if}
					{#if info.filters.length}
						<dt class="text-stone-500">filters</dt>
						<dd class="flex flex-wrap items-center gap-0.5">
							{#each info.filters as f (f)}<Icon {icons} name={f} label={labelOf(f)} size={18} />{/each}
						</dd>
					{/if}
					{#each info.rows as [k, v] (k)}
						<dt class="text-stone-500">{k}</dt>
						<dd class="break-words text-stone-200">{v}</dd>
					{/each}
				</dl>
			</div>
		{/if}
	</div>
</div>

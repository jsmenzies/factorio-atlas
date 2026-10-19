<script lang="ts">
	import { untrack } from 'svelte';
	import { describe } from '#lib/viewer/describe.js';
	import { footprint } from '#lib/viewer/geometry.js';
	import { BUCKET, BUCKET_MARGIN, CATEGORY_COLOURS, buildScene, type Scene, type Toggle } from '#lib/viewer/scene.js';
	import { overviewFile, pickLevel, tileFile, tileRect, visibleTiles, type RenderSidecar } from '#lib/viewer/game-render.js';
	import type { CompactPage } from '#lib/viewer/types.js';

	/** `render`: the page's game-look render (sidecar + URL base for its files), if any. */
	let { page, render = null }: { page: CompactPage; render?: { sidecar: RenderSidecar; base: string } | null } = $props();

	let container = $state<HTMLDivElement>();
	let canvas = $state<HTMLCanvasElement>();
	let scene = $state.raw<Scene | null>(null);
	let toggles = $state<Record<Toggle, boolean>>({ tiles: true, wires: false, grid: true, labels: true });
	let hovered = $state<number | null>(null);
	let tip = $state({ x: 0, y: 0 });
	let buildMs = $state(0);
	let zoomPct = $state(100);
	/** Game draws the offline render (same world coordinates); schematic draws shapes. */
	let mode = $state<'schematic' | 'game'>('schematic');
	let gameFailed = $state(false);
	let gameLevel = $state<number | null>(null);
	const game = $derived(mode === 'game' && !!render && !gameFailed);
	const unknownNames = $derived(new Set(Object.keys(render?.sidecar.stats.unknown ?? {})));

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
		if (!scene || !size.w || !size.h) return;
		const { x0, y0, x1, y1 } = scene.bounds;
		const bw = Math.max(4, x1 - x0 + 2);
		const bh = Math.max(4, y1 - y0 + 2);
		view.s = Math.min(MAX_S, Math.max(MIN_S, Math.min(size.w / bw, size.h / bh)));
		view.tx = size.w / 2 - ((x0 + x1) / 2) * view.s;
		view.ty = size.h / 2 - ((y0 + y1) / 2) * view.s;
		needsFit = false;
		zoomPct = Math.round(view.s * 100) / 100;
		requestDraw();
	};

	const zoomAt = (px: number, py: number, factor: number) => {
		const s = Math.min(MAX_S, Math.max(MIN_S, view.s * factor));
		const k = s / view.s;
		view.tx = px - (px - view.tx) * k;
		view.ty = py - (py - view.ty) * k;
		view.s = s;
		zoomPct = Math.round(view.s * 100) / 100;
		requestDraw();
	};

	// Game images by URL; 'error' marks a failed load so it isn't retried every frame.
	let images = new Map<string, HTMLImageElement | 'loading' | 'error'>();
	const image = (file: string, overview = false): HTMLImageElement | null => {
		const r = render;
		if (!r) return null;
		const url = `${r.base}/${file}?v=${r.sidecar.stamp}`;
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
			if (overview) gameFailed = true;
		};
		img.src = url;
		return null;
	};

	// New page or render: default to Game when there is one.
	$effect(() => {
		const r = render;
		void page;
		untrack(() => {
			images = new Map();
			gameFailed = false;
			mode = r ? 'game' : 'schematic';
		});
	});

	// Build the geometry once per page.
	$effect(() => {
		const p = page;
		untrack(() => {
			const t0 = performance.now();
			scene = buildScene(p);
			buildMs = Math.round(performance.now() - t0);
			hovered = null;
			needsFit = true;
			fit();
		});
	});

	$effect(() => {
		// Redraw when toggles or hover change.
		void [toggles.tiles, toggles.wires, toggles.grid, toggles.labels, hovered, game];
		requestDraw();
	});

	$effect(() => {
		const el = container;
		const cv = canvas;
		if (!el || !cv) return;
		const ro = new ResizeObserver(() => {
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
		// Non-passive so the page doesn't scroll while zooming.
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const r = cv.getBoundingClientRect();
			const unit = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 1 : 0.0015;
			zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * unit * (e.ctrlKey ? 4 : 1)));
		};
		cv.addEventListener('wheel', onWheel, { passive: false });
		return () => {
			ro.disconnect();
			cv.removeEventListener('wheel', onWheel);
			if (frame) cancelAnimationFrame(frame);
			frame = 0;
		};
	});

	const wrap = (ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] => {
		const words = text.split(/\s+/);
		const lines: string[] = [];
		let cur = '';
		for (const w of words) {
			const next = cur ? `${cur} ${w}` : w;
			if (ctx.measureText(next).width <= maxW || !cur) cur = next;
			else {
				lines.push(cur);
				cur = w;
			}
		}
		if (cur) lines.push(cur);
		if (lines.length > maxLines) {
			lines.length = maxLines;
			lines[maxLines - 1] += '…';
		}
		return lines.filter((l) => ctx.measureText(l).width <= maxW * 1.15);
	};

	function draw() {
		frame = 0;
		const cv = canvas;
		const sc = scene;
		if (!cv) return;
		const ctx = cv.getContext('2d');
		if (!ctx) return;
		const { w, h, dpr } = size;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.fillStyle = '#0c0a09';
		ctx.fillRect(0, 0, w, h);
		if (!sc) return;
		const { s, tx, ty } = view;
		const wx0 = -tx / s;
		const wy0 = -ty / s;
		const wx1 = (w - tx) / s;
		const wy1 = (h - ty) / s;
		const visible = sc.buckets.filter(
			(b) =>
				b.bx * BUCKET + BUCKET + BUCKET_MARGIN >= wx0 &&
				b.bx * BUCKET - BUCKET_MARGIN <= wx1 &&
				b.by * BUCKET + BUCKET + BUCKET_MARGIN >= wy0 &&
				b.by * BUCKET - BUCKET_MARGIN <= wy1
		);
		if (game && render) drawGame(ctx, render.sidecar, wx0, wy0, wx1, wy1);
		else drawSchematic(ctx, sc, visible, wx0, wy0, wx1, wy1);
		ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * tx, dpr * ty);
		ctx.globalAlpha = 1;
		ctx.setLineDash([]);

		// fpsr draws entities it has no sprites for (mods) as a 1×1 marker; show their footprint.
		if (game && unknownNames.size) {
			ctx.strokeStyle = '#f97316';
			ctx.lineWidth = Math.max(0.04, 1.5 / s);
			ctx.setLineDash([0.25, 0.15]);
			for (const e of sc.geo) {
				if (!unknownNames.has(e.name) || e.x < wx0 - 8 || e.x > wx1 + 8 || e.y < wy0 - 8 || e.y > wy1 + 8) continue;
				const [fw, fh] = footprint(e.w, e.h, e.dir);
				ctx.strokeRect(e.x - fw / 2, e.y - fh / 2, fw, fh);
			}
			ctx.setLineDash([]);
		}

		// Hover outline.
		if (hovered !== null) {
			const e = sc.geo[hovered];
			const [fw, fh] = footprint(e.w, e.h, e.dir);
			ctx.strokeStyle = '#fbbf24';
			ctx.lineWidth = Math.max(0.06, 2 / s);
			ctx.strokeRect(e.x - fw / 2, e.y - fh / 2, fw, fh);
		}

		// Labels in screen space so text stays crisp.
		if (!game && toggles.labels && s >= 8) {
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			const fontPx = Math.max(9, Math.min(13, s * 0.3));
			ctx.font = `${fontPx}px ui-sans-serif, system-ui, sans-serif`;
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			const lh = fontPx * 1.15;
			for (const b of visible) {
				for (const l of b.labels) {
					const pw = l.w * s - 6;
					const ph = l.h * s - 4;
					if (pw < 26 || ph < lh) continue;
					const cx = l.x * s + tx;
					const cy = l.y * s + ty;
					if (cx < -pw || cx > w + pw || cy < -ph || cy > h + ph) continue;
					const lines = wrap(ctx, l.text, pw, Math.max(1, Math.floor(ph / lh)));
					ctx.fillStyle = l.colour;
					lines.forEach((t, k) => ctx.fillText(t, cx, cy + (k - (lines.length - 1) / 2) * lh));
				}
			}
		}
	}

	/**
	 * The overview first (always loaded, so panning never shows holes), then the sharpest
	 * tile level the zoom needs. Edges snap to device pixels so tiles don't seam.
	 */
	function drawGame(ctx: CanvasRenderingContext2D, sc: RenderSidecar, wx0: number, wy0: number, wx1: number, wy1: number) {
		const { s, tx, ty } = view;
		const { dpr } = size;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = 'high';
		const blit = (img: HTMLImageElement, x: number, y: number, w: number, h: number) => {
			const X0 = Math.round(dpr * (x * s + tx));
			const Y0 = Math.round(dpr * (y * s + ty));
			const X1 = Math.round(dpr * ((x + w) * s + tx));
			const Y1 = Math.round(dpr * ((y + h) * s + ty));
			ctx.drawImage(img, X0, Y0, X1 - X0, Y1 - Y0);
		};
		const { frame, overview } = sc;
		const ov = image(overviewFile(sc), true);
		if (ov) blit(ov, frame.minX, frame.minY, overview.width / overview.ppt, overview.height / overview.ppt);
		const level = pickLevel(sc, s * dpr);
		gameLevel = level?.ppt ?? null;
		if (!level) return;
		for (const [c, r] of visibleTiles(sc, level, wx0, wy0, wx1, wy1)) {
			const img = image(tileFile(sc, level.ppt, c, r));
			if (!img) continue;
			const t = tileRect(sc, level, c, r);
			blit(img, t.x, t.y, t.w, t.h);
		}
	}

	function drawSchematic(
		ctx: CanvasRenderingContext2D,
		sc: Scene,
		visible: Scene['buckets'],
		wx0: number,
		wy0: number,
		wx1: number,
		wy1: number
	) {
		const { s, tx, ty } = view;
		const { dpr } = size;
		ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * tx, dpr * ty);
		ctx.lineJoin = 'round';
		let gridDrawn = false;
		const drawGrid = () => {
			gridDrawn = true;
			if (!toggles.grid || s < 5) return;
			ctx.globalAlpha = 1;
			ctx.setLineDash([]);
			ctx.lineWidth = 1 / s;
			ctx.strokeStyle = 'rgba(120,113,108,0.16)';
			ctx.beginPath();
			for (let x = Math.floor(wx0); x <= wx1; x++) {
				ctx.moveTo(x, wy0);
				ctx.lineTo(x, wy1);
			}
			for (let y = Math.floor(wy0); y <= wy1; y++) {
				ctx.moveTo(wx0, y);
				ctx.lineTo(wx1, y);
			}
			ctx.stroke();
		};
		for (const si of sc.order) {
			const st = sc.styles[si];
			if (!gridDrawn && (st.layer ?? 0) > 0) drawGrid();
			if (st.toggle && !toggles[st.toggle]) continue;
			ctx.globalAlpha = st.alpha ?? 1;
			if (st.mode === 'fill') ctx.fillStyle = st.color;
			else {
				ctx.strokeStyle = st.color;
				// Thin strokes stop growing past 3 px so close zoom stays legible.
				const lw = st.width ?? 0.1;
				ctx.lineWidth = lw < 0.2 ? Math.min(lw, 3 / s) : lw;
				ctx.lineCap = st.cap ?? 'round';
				ctx.setLineDash(st.dash ?? []);
			}
			const paint = (p: Path2D | undefined) => {
				if (!p) return;
				if (st.mode === 'fill') ctx.fill(p);
				else ctx.stroke(p);
			};
			for (const b of visible) paint(b.paths[si]);
			paint(sc.global[si]);
		}
		if (!gridDrawn) drawGrid();
	}

	// --- pointer interaction: drag to pan, pinch to zoom, hover/tap to inspect
	const pointers = new Map<number, { x: number; y: number }>();
	let moved = 0;
	let pinch: { d: number; s: number; wx: number; wy: number } | null = null;

	const local = (e: PointerEvent | MouseEvent) => {
		const r = canvas!.getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	};

	const pick = (px: number, py: number) => {
		if (!scene) return;
		const wx = Math.floor((px - view.tx) / view.s);
		const wy = Math.floor((py - view.ty) / view.s);
		const key = (wx + 1048576) * 2097152 + (wy + 1048576);
		hovered = scene.hit.get(key) ?? null;
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
			if (moved > 4) hovered = null;
			requestDraw();
		} else if (pointers.size === 2 && pinch) {
			const p = pinchState();
			view.s = Math.min(MAX_S, Math.max(MIN_S, (pinch.s * p.d) / pinch.d));
			view.tx = p.mx - pinch.wx * view.s;
			view.ty = p.my - pinch.wy * view.s;
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
		else return;
		e.preventDefault();
		requestDraw();
	};

	const info = $derived(
		scene && hovered !== null
			? describe(page, scene.geo, hovered, {
					shapes: scene.shapes,
					undergroundPartner: scene.undergroundPartner,
					pipes: scene.pipes
				})
			: null
	);

	const TOGGLES: [Toggle, string][] = [
		['tiles', 'Tiles'],
		['wires', 'Wires'],
		['grid', 'Grid'],
		['labels', 'Labels']
	];
	const LEGEND = (['production', 'power', 'logistics', 'circuits', 'rail', 'defence', 'other', 'unknown'] as const).map(
		(c) => [c, CATEGORY_COLOURS[c]] as const
	);
</script>

<div class="flex h-full min-h-0 flex-col">
	<div class="flex flex-wrap items-center gap-2 border-b border-stone-800 bg-stone-900/80 px-3 py-1.5 text-xs">
		<div class="flex overflow-hidden rounded border border-stone-700" role="group" aria-label="View">
			<button
				class="px-2 py-0.5 {mode === 'schematic' ? 'bg-amber-400 text-stone-950' : 'bg-stone-800 hover:bg-stone-700'}"
				aria-pressed={mode === 'schematic'}
				onclick={() => (mode = 'schematic')}>Schematic</button
			>
			<button
				class="px-2 py-0.5 disabled:cursor-not-allowed disabled:opacity-40 {mode === 'game' ? 'bg-amber-400 text-stone-950' : 'bg-stone-800 hover:bg-stone-700'}"
				aria-pressed={mode === 'game'}
				disabled={!render || gameFailed}
				title={render ? 'Rendered image of this page' : 'No game render for this page yet'}
				onclick={() => (mode = 'game')}>Game</button
			>
		</div>
		{#if game && render}
			{#if render.sidecar.assets.placeholder}
				<span
					class="rounded bg-amber-900/60 px-1.5 py-0.5 text-amber-200"
					title="Drawn with placeholder sprites (flat boxes and direction arrows), not Factorio's art">placeholder sprites</span
				>
			{/if}
			{#if unknownNames.size}
				<span class="text-orange-300" title={[...unknownNames].join(', ')}>{unknownNames.size} modded types outlined</span>
			{/if}
			<span class="text-stone-500" title="Rendered offline by fpsr {render.sidecar.fpsr} for Factorio {render.sidecar.assets.gameVersion}"
				>{gameLevel ? `${gameLevel} px/tile tiles` : 'overview'}</span
			>
		{:else}
			{#if !render}
				<span class="text-stone-500">schematic only: no game render for this page yet</span>
			{:else if gameFailed}
				<span class="text-red-300">game render failed to load</span>
			{/if}
			{#each TOGGLES as [key, name] (key)}
				<label class="flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 hover:bg-stone-800">
					<input type="checkbox" class="accent-amber-400" bind:checked={toggles[key]} />
					{name}
				</label>
			{/each}
		{/if}
		<span class="mx-1 h-4 w-px bg-stone-700"></span>
		<button class="rounded bg-stone-800 px-2 py-0.5 hover:bg-stone-700" onclick={fit} title="Fit to view (F)">Fit</button>
		<button class="rounded bg-stone-800 px-2 py-0.5 hover:bg-stone-700" onclick={() => zoomAt(size.w / 2, size.h / 2, 1.25)} title="Zoom in (+)"
			>+</button
		>
		<button class="rounded bg-stone-800 px-2 py-0.5 hover:bg-stone-700" onclick={() => zoomAt(size.w / 2, size.h / 2, 0.8)} title="Zoom out (−)"
			>−</button
		>
		<span class="text-stone-500">{zoomPct} px/tile</span>
		<span class="ml-auto text-stone-500">
			{page.entities.length.toLocaleString()} entities{#if page.tiles.length}
				· {page.tiles.reduce((n, t) => n + t.runs.length / 3, 0).toLocaleString()} tile runs{/if} · built in {buildMs} ms
		</span>
	</div>
	<div bind:this={container} class="relative min-h-0 flex-1 overflow-hidden">
		<canvas
			bind:this={canvas}
			class="absolute inset-0 h-full w-full cursor-grab touch-none outline-none active:cursor-grabbing"
			tabindex="0"
			aria-label="Blueprint {game ? 'render' : 'schematic'}. Drag to pan, scroll or pinch to zoom, F to fit."
			{onpointerdown}
			{onpointermove}
			{onpointerup}
			onpointercancel={onpointerup}
			{onpointerleave}
			{onkeydown}
		></canvas>
		{#if info}
			<div
				class="pointer-events-none absolute z-10 max-w-xs rounded border border-stone-700 bg-stone-900/95 px-2.5 py-2 text-xs shadow-lg"
				style:left="{Math.min(tip.x + 14, size.w - 260)}px"
				style:top="{Math.min(tip.y + 14, size.h - 200)}px"
			>
				<div class="mb-1 font-semibold text-amber-300">{info.title}</div>
				<dl class="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
					{#each info.rows as [k, v] (k)}
						<dt class="text-stone-500">{k}</dt>
						<dd class="break-words text-stone-200">{v}</dd>
					{/each}
				</dl>
			</div>
		{/if}
		<div class:hidden={game} class="pointer-events-none absolute bottom-2 left-2 flex flex-wrap gap-x-3 gap-y-1 rounded bg-stone-950/80 px-2 py-1 text-[11px] text-stone-400">
			<span class="flex items-center gap-1"><i class="h-2 w-3 rounded-sm bg-[#e3b341]"></i>belt</span>
			<span class="flex items-center gap-1"><i class="h-2 w-3 rounded-sm bg-[#e5534b]"></i>fast</span>
			<span class="flex items-center gap-1"><i class="h-2 w-3 rounded-sm bg-[#4aa8f0]"></i>express</span>
			<span class="flex items-center gap-1"><i class="h-2 w-3 rounded-sm bg-[#6bd66f]"></i>turbo</span>
			<span class="flex items-center gap-1"><i class="h-2 w-3 rounded-sm bg-[#7fa7c4]"></i>pipe</span>
			<span class="flex items-center gap-1"><i class="h-2 w-3 rounded-sm bg-[#38bdf8]"></i>fluid in</span>
			<span class="flex items-center gap-1"><i class="h-2 w-3 rounded-sm bg-[#fb923c]"></i>fluid out</span>
			{#each LEGEND as [c, colour] (c)}
				<span class="flex items-center gap-1"><i class="h-2 w-3 rounded-sm border" style:border-color={colour}></i>{c}</span>
			{/each}
		</div>
	</div>
</div>

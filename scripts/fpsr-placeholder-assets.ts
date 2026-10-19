/**
 * Placeholder fpsr asset bundle: no Factorio art, just flat boxes where the sprites go.
 *
 *   bun scripts/fpsr-placeholder-assets.ts [--fixture <render-db.json>] [--out <dir>]
 *
 * fpsr commits a metadata-only render database (frame rectangles, no pixels) for its tests.
 * This takes that file, paints every frame rectangle with a flat colour by entity category,
 * an outline and a direction mark, and writes a schema-2 bundle `localAssets()` accepts:
 * manifest.json, a content-addressed render-db per tier and lossless WebP atlas pages
 * named by their own sha256. Real assets from `pnpm assets:build` drop in the same way.
 *
 * Output: .cache/fpsr-placeholder/<gameVersion>/ (gitignored). The manifest carries
 * `placeholder: true` so renders made from it can be told apart and redone later.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EntityRenderDef, FrameMeta, RenderDb, SpriteVariant } from '@rickyzhangca/fpsr/render-db';
import { Canvas, type CanvasRenderingContext2D } from 'skia-canvas';
import { categoryOf } from '#lib/viewer/extract.js';
import type { Category } from '#lib/viewer/types.js';

const ROOT = join(import.meta.dirname, '..');
const CACHE = join(ROOT, '.cache', 'fpsr-placeholder');

/** fpsr commit the fixture is pinned to (published as 0.0.3 the same day). */
const FPSR_COMMIT = '2f7dc70f2681de530402556f757006e904e692d5';
const FIXTURE_URL = `https://raw.githubusercontent.com/rickyzhangca/fpsr/${FPSR_COMMIT}/fixtures/render-db/2.1.11.json`;
const FIXTURE_SHA256 = 'e1bb539bdd4921a3cdf3bc24773848ccb7d679e762a5877bd966cc71a3cd8407';

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

const arg = (name: string) => {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
};

/** Metadata only (MIT, no pixels). Downloaded once and checked against the pinned hash. */
async function loadFixture(): Promise<RenderDb> {
	const given = arg('--fixture');
	if (given) return JSON.parse(await readFile(given, 'utf8')) as RenderDb;
	const cached = join(CACHE, 'fixture-render-db-2.1.11.json');
	let text = await readFile(cached, 'utf8').catch(() => null);
	if (text === null) {
		console.log(`fetching ${FIXTURE_URL}`);
		const res = await fetch(FIXTURE_URL);
		if (!res.ok) throw new Error(`fixture fetch failed: ${res.status}`);
		text = await res.text();
		if (sha256(text) !== FIXTURE_SHA256) throw new Error('fixture sha256 mismatch; refusing to use it');
		await mkdir(CACHE, { recursive: true });
		await writeFile(cached, text);
	}
	return JSON.parse(text) as RenderDb;
}

// --- what each frame is for -------------------------------------------------------------

const PALETTE: Record<Category, string> = {
	belts: '#e3b341',
	inserters: '#eab308',
	production: '#6aa7ee',
	power: '#facc15',
	logistics: '#d6a76b',
	circuits: '#34d399',
	rail: '#a1a1aa',
	defence: '#f87171',
	other: '#a8a29e',
	unknown: '#9ca3af'
};
const BELT_TIERS: [RegExp, string][] = [
	[/^turbo-/, '#6bd66f'],
	[/^express-/, '#4aa8f0'],
	[/^fast-/, '#e5534b']
];
const BELT_TYPES = new Set(['transport-belt', 'underground-belt', 'splitter', 'loader', 'loader-1x1', 'linked-belt', 'lane-splitter']);

const colourOf = (name: string, protoType: string): string => {
	if (BELT_TYPES.has(protoType)) return BELT_TIERS.find(([re]) => re.test(name))?.[1] ?? PALETTE.belts;
	if (protoType === 'inserter') return PALETTE.inserters;
	return PALETTE[categoryOf(protoType)];
};

/** "assembling-machine-2" → "AM2", "pipe-to-ground" → "PTG". */
const abbrev = (name: string) =>
	name
		.split(/[-_/]/)
		.filter(Boolean)
		.map((w) => (/^\d+$/.test(w) ? w : w[0].toUpperCase()))
		.join('')
		.slice(0, 4);

type Mark = { t: 'arrow'; deg: number } | { t: 'curve'; from: number; to: number } | { t: 'stubs'; mask: string } | { t: 'none' };

interface SpriteRole {
	t: 'sprite';
	name: string;
	colour: string;
	/** Largest non-shadow layer of its entity: drawn solid, the rest faint. */
	primary: boolean;
	shadow: boolean;
	/** Source pixels per tile at this variant's scale. */
	tilePx: number;
	marks: Mark[];
	label?: string;
}
type Role =
	| SpriteRole
	| { t: 'icon'; key: string }
	| { t: 'tile'; colour: [number, number, number, number]; tilePx: number }
	| { t: 'terrain'; colour: [number, number, number, number] }
	| { t: 'planet' };

/** Belt resolver rows (fpsr resolve/belts.ts): 0-3 straight E W N S, 4-11 curves, 12-19 end caps. */
const BELT_STRAIGHT = [90, 270, 0, 180];
// [from side, to side] in degrees for rows 4..11 (east_to_north, north_to_east, ...).
const BELT_CURVES: [number, number][] = [
	[90, 0],
	[0, 90],
	[270, 0],
	[0, 270],
	[180, 90],
	[90, 180],
	[180, 270],
	[270, 180]
];

function markFor(def: EntityRenderDef, indexing: string, key: string, index: number, variant: SpriteVariant): Mark {
	// Rotated variants (inserter hands) share north-facing art; fpsr turns it.
	if (variant.rotation !== undefined) return { t: 'arrow', deg: 0 };
	if (/^[01]{4}$/.test(key)) return { t: 'stubs', mask: key };
	if (indexing === 'resolver' && def.kind === 'belt') {
		if (index < 4) return { t: 'arrow', deg: BELT_STRAIGHT[index] };
		const c = BELT_CURVES[index - 4];
		return c ? { t: 'curve', from: c[0], to: c[1] } : { t: 'none' };
	}
	// Inserters name their pickup side; point the arrow the way items move.
	const flip = def.protoType === 'inserter' ? 180 : 0;
	if (indexing === 'direction4') return { t: 'arrow', deg: (index * 90 + flip) % 360 };
	if (indexing === 'direction8') return { t: 'arrow', deg: (index * 45 + flip) % 360 };
	if (indexing === 'direction16') return { t: 'arrow', deg: (index * 22.5 + flip) % 360 };
	return { t: 'none' };
}

const sameMark = (a: Mark, b: Mark) => JSON.stringify(a) === JSON.stringify(b);

function assignRoles(db: RenderDb): Map<number, Role> {
	const roles = new Map<number, Role>();
	const claim = (frame: number | undefined | null, role: Role) => {
		if (frame == null || !db.frames[frame]) return;
		const had = roles.get(frame);
		if (!had) return void roles.set(frame, role);
		// A frame shared by several directions is symmetric: drop conflicting marks.
		if (had.t === 'sprite' && role.t === 'sprite' && had.name === role.name) {
			for (const m of role.marks) if (!had.marks.some((h) => sameMark(h, m))) had.marks.push(m);
		}
	};
	// On-map area, so hi-res inserter hands (scale 0.25) don't outweigh the platform.
	const area = (v: SpriteVariant | null) => {
		const f = v ? db.frames[v.frame] : undefined;
		return f && v ? f.w * f.h * v.scale * v.scale : 0;
	};

	// Belts first: splitters, undergrounds and loaders reuse belt frames under other indexing.
	const entities = Object.entries(db.entities).sort(([, a], [, b]) => Number(b.kind === 'belt') - Number(a.kind === 'belt'));
	for (const [name, def] of entities) {
		const colour = colourOf(name, def.protoType);
		const groupArea = def.graphics.map((g) => {
			const vs = Object.values(g.variants)
				.flat()
				.filter((v): v is SpriteVariant => !!v && !v.drawAsShadow);
			return vs.length ? vs.reduce((s, v) => s + area(v), 0) / vs.length : 0;
		});
		const primaryGroup = groupArea.indexOf(Math.max(...groupArea));
		def.graphics.forEach((g, gi) => {
			for (const [key, list] of Object.entries(g.variants)) {
				list.forEach((v, index) => {
					if (!v) return;
					const label = /^(in|input)$/.test(key) ? 'IN' : /^(out|output)$/.test(key) ? 'OUT' : undefined;
					claim(v.frame, {
						t: 'sprite',
						name,
						colour,
						primary: gi === primaryGroup && !v.drawAsShadow,
						shadow: !!v.drawAsShadow,
						tilePx: 32 / (v.scale || 0.5),
						marks: [markFor(def, g.indexing, key, index, v)],
						label
					});
				});
			}
		});
	}
	// Pipe covers, circuit connectors, cargo-bay pieces and the like: faint, unmarked.
	const walk = (value: unknown, name: string, colour: string) => {
		if (!value || typeof value !== 'object') return;
		if (Array.isArray(value)) return value.forEach((x) => walk(x, name, colour));
		const o = value as Record<string, unknown>;
		if (typeof o.frame === 'number') {
			const v = o as unknown as SpriteVariant;
			claim(v.frame, { t: 'sprite', name, colour, primary: false, shadow: !!v.drawAsShadow, tilePx: 32 / (v.scale || 0.5), marks: [] });
		}
		for (const [k, x] of Object.entries(o)) if (k !== 'frame') walk(x, name, colour);
	};
	for (const [name, def] of Object.entries(db.entities)) walk(def.data, name, colourOf(name, def.protoType));

	for (const t of Object.values(db.tiles)) {
		for (const f of t.frames ?? []) claim(f, { t: 'tile', colour: t.color, tilePx: 64 });
		if (t.material) claim(t.material.sheet, { t: 'tile', colour: t.color, tilePx: t.material.tilePx });
	}
	for (const bg of Object.values(db.terrainBackgrounds ?? {})) {
		if (!bg) continue;
		for (const f of [...bg.frames, ...(bg.patches ?? []).flatMap((p) => p.frames)]) claim(f, { t: 'terrain', colour: bg.color });
	}
	if (db.spaceBackground) {
		claim(db.spaceBackground.planetFrame, { t: 'planet' });
		for (const f of Object.values(db.spaceBackground.planets ?? {})) claim(f, { t: 'planet' });
	}
	for (const [key, f] of Object.entries(db.icons)) claim(f, { t: 'icon', key });
	for (const [name, def] of Object.entries(db.entities)) claim(def.icon, { t: 'icon', key: `entity/${name}` });
	return roles;
}

// --- painting ----------------------------------------------------------------------------

const rgba = ([r, g, b, a]: [number, number, number, number], alpha = a) =>
	`rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${alpha})`;

const hue = (s: string) => parseInt(sha256(s).slice(0, 4), 16) % 360;

const unit = (deg: number): [number, number] => {
	const r = (deg * Math.PI) / 180;
	return [Math.sin(r), -Math.cos(r)];
};

function arrow(ctx: CanvasRenderingContext2D, cx: number, cy: number, deg: number, len: number) {
	const [dx, dy] = unit(deg);
	const [px, py] = [-dy, dx];
	const hx = cx + dx * len;
	const hy = cy + dy * len;
	const head = len * 0.55;
	ctx.beginPath();
	ctx.moveTo(cx - dx * len * 0.8, cy - dy * len * 0.8);
	ctx.lineTo(hx - dx * head * 0.6, hy - dy * head * 0.6);
	ctx.stroke();
	ctx.beginPath();
	ctx.moveTo(hx, hy);
	ctx.lineTo(hx - dx * head + px * head * 0.6, hy - dy * head + py * head * 0.6);
	ctx.lineTo(hx - dx * head - px * head * 0.6, hy - dy * head - py * head * 0.6);
	ctx.closePath();
	ctx.fill();
}

function paintSprite(ctx: CanvasRenderingContext2D, f: FrameMeta, role: SpriteRole) {
	const { x, y, w, h } = f;
	if (role.shadow) {
		ctx.fillStyle = 'rgba(0,0,0,0.55)';
		ctx.fillRect(x, y, w, h);
		return;
	}
	const T = role.tilePx;
	ctx.fillStyle = role.colour;
	ctx.globalAlpha = role.primary ? 0.6 : 0.22;
	ctx.fillRect(x, y, w, h);
	ctx.globalAlpha = role.primary ? 1 : 0.7;
	ctx.strokeStyle = role.colour;
	const lw = Math.max(1, Math.min(3, T / 24));
	ctx.lineWidth = lw;
	ctx.strokeRect(x + lw / 2, y + lw / 2, w - lw, h - lw);
	ctx.globalAlpha = 1;
	if (w < 6 || h < 6) return;

	// Marks sit on the untrimmed sprite's centre (the entity position) when it's inside.
	let cx = x - f.ox + f.sw / 2;
	let cy = y - f.oy + f.sh / 2;
	if (cx < x || cx > x + w || cy < y || cy > y + h) [cx, cy] = [x + w / 2, y + h / 2];
	const marks = role.marks.filter((m) => m.t !== 'none');
	// More than one direction on the same art means it doesn't turn; skip the arrow.
	const mark = marks.length === 1 ? marks[0] : null;
	const len = Math.min(T * 0.32, w * 0.4, h * 0.4);
	ctx.strokeStyle = ctx.fillStyle = role.primary ? '#fafaf9' : role.colour;
	ctx.lineWidth = Math.max(1.5, len * 0.22);
	ctx.lineCap = 'round';
	if (mark?.t === 'arrow') arrow(ctx, cx, cy, mark.deg, len);
	else if (mark?.t === 'curve') {
		const [fx, fy] = unit(mark.from);
		const [tx, ty] = unit(mark.to);
		const r = T * 0.45;
		ctx.beginPath();
		ctx.moveTo(cx + fx * r, cy + fy * r);
		ctx.quadraticCurveTo(cx, cy, cx + tx * r * 0.55, cy + ty * r * 0.55);
		ctx.stroke();
		arrow(ctx, cx + tx * r * 0.45, cy + ty * r * 0.45, mark.to, len * 0.6);
	} else if (mark?.t === 'stubs') {
		ctx.beginPath();
		[0, 90, 180, 270].forEach((deg, i) => {
			if (mark.mask[i] !== '1') return;
			const [dx, dy] = unit(deg);
			ctx.moveTo(cx, cy);
			ctx.lineTo(cx + dx * T * 0.5, cy + dy * T * 0.5);
		});
		ctx.lineWidth = Math.max(2, T * 0.14);
		ctx.stroke();
		ctx.beginPath();
		ctx.arc(cx, cy, Math.max(2, T * 0.1), 0, Math.PI * 2);
		ctx.fill();
	}
	// Name on big bodies so placeholder renders stay readable; IN/OUT on underground ends.
	const text = role.label ?? (role.primary && w >= T * 1.4 && h >= T * 1.4 ? abbrev(role.name) : null);
	if (text) {
		const px = Math.max(9, Math.min(T * 0.42, w / (text.length * 0.75)));
		ctx.font = `bold ${px}px sans-serif`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillStyle = 'rgba(250,250,249,0.92)';
		ctx.fillText(text, x + w / 2, Math.min(y + h - px * 0.7, cy + (mark ? len + px * 0.8 : 0)));
	}
}

function paintFrame(ctx: CanvasRenderingContext2D, f: FrameMeta, role: Role | undefined) {
	const { x, y, w, h } = f;
	ctx.save();
	ctx.beginPath();
	ctx.rect(x, y, w, h);
	ctx.clip();
	if (!role) {
		ctx.fillStyle = 'rgba(255,0,255,0.5)';
		ctx.fillRect(x, y, w, h);
	} else if (role.t === 'sprite') paintSprite(ctx, f, role);
	else if (role.t === 'tile' || role.t === 'terrain') {
		ctx.fillStyle = rgba(role.colour, 1);
		ctx.fillRect(x, y, w, h);
		if (role.t === 'tile') {
			ctx.strokeStyle = 'rgba(0,0,0,0.25)';
			ctx.lineWidth = 1;
			for (let gx = x; gx < x + w; gx += role.tilePx) ctx.strokeRect(gx + 0.5, y + 0.5, role.tilePx - 1, h - 1);
			for (let gy = y; gy < y + h; gy += role.tilePx) ctx.strokeRect(x + 0.5, gy + 0.5, w - 1, role.tilePx - 1);
		}
	} else if (role.t === 'planet') {
		ctx.fillStyle = '#1e293b';
		ctx.beginPath();
		ctx.arc(x + w / 2, y + h / 2, Math.min(w, h) / 2, 0, Math.PI * 2);
		ctx.fill();
	} else {
		// Icons: rounded swatch with the name's initials.
		const name = role.key.split('/').pop() ?? role.key;
		const unsupported = role.key === 'utility/unsupported-entity';
		ctx.fillStyle = unsupported ? '#f97316' : `hsl(${hue(role.key)} 45% 32%)`;
		const r = Math.min(w, h) * 0.18;
		ctx.beginPath();
		ctx.roundRect(x + 1, y + 1, w - 2, h - 2, r);
		ctx.fill();
		const text = unsupported ? '?' : abbrev(name);
		const px = Math.max(6, Math.min(h * 0.5, (w * 1.2) / Math.max(1, text.length)));
		ctx.font = `bold ${px}px sans-serif`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillStyle = '#fafaf9';
		ctx.fillText(text, x + w / 2, y + h / 2);
	}
	ctx.restore();
}

// --- bundle ------------------------------------------------------------------------------

interface TierOut {
	density: 1 | 2;
	atlases: { file: string; w: number; h: number; sha256: string; bytes: number }[];
	renderDb: { file: string; sha256: string; bytes: number };
}

async function writeTier(dir: string, db: RenderDb, images: Canvas[], density: 1 | 2): Promise<TierOut> {
	const atlases: TierOut['atlases'] = [];
	for (const [i, canvas] of images.entries()) {
		const data = await canvas.toBuffer('webp', { quality: 1 });
		const hash = sha256(data);
		const file = `atlas.${hash}.webp`;
		await writeFile(join(dir, file), data);
		atlases.push({ file, w: canvas.width, h: canvas.height, sha256: hash, bytes: data.byteLength });
		db.atlases[i] = { file, width: canvas.width, height: canvas.height };
	}
	const json = JSON.stringify({ ...db, assetDensity: density });
	const hash = sha256(json);
	const file = `render-db.${hash}.json`;
	await writeFile(join(dir, file), json);
	return { density, atlases, renderDb: { file, sha256: hash, bytes: Buffer.byteLength(json) } };
}

const fixture = await loadFixture();
if (fixture.schema !== 2) throw new Error(`expected render-db schema 2, got ${String(fixture.schema)}`);
const out = arg('--out') ?? join(CACHE, fixture.gameVersion);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const t0 = performance.now();
const roles = assignRoles(fixture);
const pages = fixture.atlases.map((a) => new Canvas(a.width, a.height));
fixture.frames.forEach((f, id) => {
	const ctx = pages[f.a]?.getContext('2d');
	if (ctx) paintFrame(ctx, f, roles.get(id));
});

const db2: RenderDb = structuredClone(fixture);
const tier2 = await writeTier(out, db2, pages, 2);

// 1x tier: same frames at half resolution; logical geometry stays canonical, `pw`/`ph` hold
// the packed size (as the real pipeline does).
const half = pages.map((p) => {
	const c = new Canvas(Math.ceil(p.width / 2), Math.ceil(p.height / 2));
	const ctx = c.getContext('2d');
	// Nearest-neighbour keeps the flat colours flat, so the 1x pages compress like the real ones.
	ctx.imageSmoothingEnabled = false;
	ctx.drawImage(p, 0, 0, c.width, c.height);
	return c;
});
const db1: RenderDb = structuredClone(fixture);
db1.frames = fixture.frames.map((f) => ({
	...f,
	x: Math.floor(f.x / 2),
	y: Math.floor(f.y / 2),
	pw: Math.max(1, Math.ceil(f.w / 2)),
	ph: Math.max(1, Math.ceil(f.h / 2))
}));
const tier1 = await writeTier(out, db1, half, 1);

const manifest = {
	schema: 2,
	gameVersion: fixture.gameVersion,
	mods: fixture.mods,
	tiers: { '1x': tier1, '2x': tier2 },
	// Not part of fpsr's schema; it ignores unknown keys. Lets renders say what drew them.
	placeholder: true,
	placeholderSource: `fpsr@${FPSR_COMMIT.slice(0, 7)} fixtures/render-db/${fixture.gameVersion}.json`
};
await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));

const bytes = [...tier1.atlases, ...tier2.atlases].reduce((s, a) => s + a.bytes, 0);
const unclaimed = fixture.frames.length - roles.size;
console.log(
	`wrote ${out}: ${pages.length} atlases per tier, ${fixture.frames.length} frames ` +
		`(${unclaimed} unreferenced), ${(bytes / 1024 / 1024).toFixed(1)} MB, ${Math.round(performance.now() - t0)} ms`
);

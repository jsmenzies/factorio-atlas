import { directionName, inserterHands, type BeltShape, type GeoEntity, type PipeNetwork } from './geometry.js';
import type { CompactPage } from './types.js';

export interface Description {
	title: string;
	rows: [string, string][];
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

/** Tooltip rows for one entity. */
export const describe = (
	page: CompactPage,
	geo: GeoEntity[],
	i: number,
	ctx: { shapes: BeltShape[]; undergroundPartner: Int32Array; pipes: PipeNetwork }
): Description => {
	const [n, x, y, dir, extra] = page.entities[i];
	const info = page.names[n];
	const e = geo[i];
	const rows: [string, string][] = [];
	rows.push(['position', `${fmt(x)}, ${fmt(y)}`]);
	const raw = page.sourceDirections === 8 ? dir / 2 : dir;
	rows.push(['direction', `${directionName(dir)} (${raw} of ${page.sourceDirections})`]);
	if (info.proto !== info.name) rows.push(['2.0 name', info.proto]);
	rows.push(['category', info.known ? `${info.category} · ${info.type}` : 'unknown (modded or renamed)']);
	if (!info.known && e.kind === 'box') rows.push(['size', `${e.w}×${e.h}, guessed from free space`]);
	else if (info.w * info.h > 1) rows.push(['size', `${info.w}×${info.h}`]);
	if (extra?.recipe) rows.push(['recipe', extra.recipe + (extra.recipeQuality ? ` (${extra.recipeQuality})` : '')]);
	if (extra?.modules?.length) rows.push(['modules', extra.modules.join(', ')]);
	if (extra?.quality) rows.push(['quality', extra.quality]);
	if (extra?.mirror) rows.push(['mirrored', 'yes']);
	if (e.kind === 'belt') {
		const s = ctx.shapes[i];
		rows.push(['shape', s === 0 ? 'straight' : `curve, fed from the ${s < 0 ? 'left' : 'right'}`]);
	}
	if (e.kind === 'underground') {
		const p = ctx.undergroundPartner[i];
		rows.push(['end', extra?.io === 'in' ? 'entrance' : 'exit']);
		rows.push([
			'paired with',
			p >= 0 ? `${fmt(geo[p].x)}, ${fmt(geo[p].y)} (${Math.abs(geo[p].x - x) + Math.abs(geo[p].y - y)} tiles)` : 'nothing in range'
		]);
	}
	if (e.kind === 'pipe-to-ground') {
		const p = ctx.pipes.underground[i];
		rows.push(['paired with', p >= 0 ? `${fmt(geo[p].x)}, ${fmt(geo[p].y)}` : 'nothing in range']);
	}
	if (e.kind === 'loader' && extra?.io) rows.push(['mode', extra.io === 'in' ? 'loading' : 'unloading']);
	if (e.kind === 'splitter') {
		if (extra?.inPri) rows.push(['input priority', extra.inPri]);
		if (extra?.outPri) rows.push(['output priority', extra.outPri]);
		if (extra?.filter) rows.push(['filter', extra.filter]);
	}
	if (e.kind === 'inserter') {
		const { pickup, drop } = inserterHands(e);
		rows.push(['picks up', `${fmt(pickup[0])}, ${fmt(pickup[1])}${extra?.pickup ? ' (custom)' : ''}`]);
		rows.push(['drops', `${fmt(drop[0])}, ${fmt(drop[1])}${extra?.drop ? ' (custom)' : ''}`]);
		if (extra?.filters?.length) rows.push(['filters', extra.filters.join(', ')]);
	}
	if (extra?.text) rows.push(['text', extra.text]);
	const ports = ctx.pipes.portsOf[i].map((p) => ctx.pipes.ports[p]);
	if (ports.length && e.kind !== 'pipe' && e.kind !== 'pipe-to-ground') {
		rows.push(['fluid ports', `${ports.filter((p) => p.joined !== -1).length} of ${ports.length} connected`]);
	}
	return { title: info.name, rows };
};

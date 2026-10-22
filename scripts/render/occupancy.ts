/**
 * Which parts of a page fpsr can draw anything on, from its draw list, so tiles nothing can reach
 * are left transparent without drawing or reading them (sparse pages are mostly empty space).
 * Conservative: every command counts with its whole destination rect (the visible sprite is
 * inside it), rotated rects with their circumscribed square, wires with their sag, the snap grid
 * with its perimeter, plus a margin.
 */
import type { DrawCmd, DrawList } from '@rickyzhangca/fpsr/planner';

/** Grid cell in world tiles: the smallest output tile (512 px at 64 px/tile) spans 8. */
const CELL = 8;
/** World tiles added around every command. */
const MARGIN = 1;

type Box = [number, number, number, number];

function box(cmd: Exclude<DrawCmd, { kind: 'snap-grid' }>): Box | null {
	switch (cmd.kind) {
		case 'sprite':
		case 'rect': {
			const rotation = cmd.kind === 'sprite' ? (cmd.rotation ?? 0) : 0;
			if (rotation % 360 === 0) return [cmd.x, cmd.y, cmd.x + cmd.w, cmd.y + cmd.h];
			const cx = cmd.x + cmd.w / 2;
			const cy = cmd.y + cmd.h / 2;
			const r = Math.hypot(cmd.w, cmd.h) / 2;
			return [cx - r, cy - r, cx + r, cy + r];
		}
		case 'icon': {
			// Backings and silhouettes reach past the icon itself; a full size either side covers them.
			return [cmd.x - cmd.size, cmd.y - cmd.size, cmd.x + cmd.size, cmd.y + cmd.size];
		}
		case 'text': {
			const w = cmd.text.length * cmd.size + cmd.size;
			return [cmd.x - w, cmd.y - 2 * cmd.size, cmd.x + w, cmd.y + 2 * cmd.size];
		}
		case 'wire': {
			const sag = 0.2 * Math.hypot(cmd.x2 - cmd.x1, cmd.y2 - cmd.y1);
			return [Math.min(cmd.x1, cmd.x2), Math.min(cmd.y1, cmd.y2), Math.max(cmd.x1, cmd.x2), Math.max(cmd.y1, cmd.y2) + sag];
		}
		case 'train-chain': {
			let b: Box | null = null;
			for (const s of cmd.segments) {
				const sb: Box = [Math.min(s.x1, s.x2), Math.min(s.y1, s.y2), Math.max(s.x1, s.x2), Math.max(s.y1, s.y2)];
				b = b ? [Math.min(b[0], sb[0]), Math.min(b[1], sb[1]), Math.max(b[2], sb[2]), Math.max(b[3], sb[3])] : sb;
			}
			for (const j of cmd.joints) {
				const jb: Box = [j.x - 1, j.y - 1, j.x + 1, j.y + 1];
				b = b ? [Math.min(b[0], jb[0]), Math.min(b[1], jb[1]), Math.max(b[2], jb[2]), Math.max(b[3], jb[3])] : jb;
			}
			return b;
		}
		default:
			return null;
	}
}

/** fpsr strokes the snap-to-grid rectangle's perimeter only, so its four edges are what it paints. */
const boxes = (cmd: DrawCmd): (Box | null)[] => {
	if (cmd.kind !== 'snap-grid') return [box(cmd)];
	const { x, y, w, h } = cmd;
	return [
		[x, y, x + w, y],
		[x, y + h, x + w, y + h],
		[x, y, x, y + h],
		[x + w, y, x + w, y + h]
	];
};

export interface Occupancy {
	/** False only when no command can paint inside the world rect [x0, x1) × [y0, y1). */
	any(x0: number, y0: number, x1: number, y1: number): boolean;
}

/** `frame`: the page's world-tile frame (integers), the area every level covers. */
export function occupancy(list: DrawList, frame: { minX: number; minY: number; maxX: number; maxY: number }): Occupancy {
	const cols = Math.max(1, Math.ceil((frame.maxX - frame.minX) / CELL));
	const rows = Math.max(1, Math.ceil((frame.maxY - frame.minY) / CELL));
	const cells = new Uint8Array(cols * rows);
	const col = (x: number) => Math.min(cols - 1, Math.max(0, Math.floor((x - frame.minX) / CELL)));
	const row = (y: number) => Math.min(rows - 1, Math.max(0, Math.floor((y - frame.minY) / CELL)));
	let unknown = false;
	for (const cmd of list.commands) {
		for (const b of boxes(cmd)) {
			if (!b || !b.every(Number.isFinite)) {
				// A command we can't bound: assume it could paint anywhere.
				unknown = true;
				break;
			}
			const [c0, c1, r0, r1] = [col(b[0] - MARGIN), col(b[2] + MARGIN), row(b[1] - MARGIN), row(b[3] + MARGIN)];
			for (let r = r0; r <= r1; r++) cells.fill(1, r * cols + c0, r * cols + c1 + 1);
		}
		if (unknown) break;
	}
	if (unknown) return { any: () => true };
	return {
		any(x0, y0, x1, y1) {
			const [c0, c1, r0, r1] = [col(x0), col(x1 - 1e-9), row(y0), row(y1 - 1e-9)];
			for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (cells[r * cols + c]) return true;
			return false;
		}
	};
}

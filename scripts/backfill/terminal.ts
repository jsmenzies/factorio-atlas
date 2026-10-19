/**
 * The backfill's terminal: on a TTY, a status block redrawn in place with log lines scrolling above
 * it, and single-key controls; otherwise one status line every ~10 s.
 */
import { createInterface } from 'node:readline/promises';

export type Key = 'pause' | 'resume' | 'stop' | 'quit' | 'interrupt';

const KEYS: Record<string, Key> = { p: 'pause', r: 'resume', s: 'stop', q: 'quit', '\u0003': 'interrupt' };

export class Terminal {
	readonly tty = Boolean(process.stdout.isTTY);
	private drawn = 0;
	private block: string[] = [];
	private keyHandler: ((data: Buffer) => void) | null = null;

	/** Replace the status block (TTY only). Lines are cut to the terminal's width so redraws stay aligned. */
	draw(lines: string[]) {
		if (!this.tty) return;
		const width = process.stdout.columns || 120;
		this.block = lines.map((l) => (l.length > width - 1 ? `${l.slice(0, width - 2)}…` : l));
		process.stdout.write(`${this.clear()}${this.block.join('\n')}\n`);
		this.drawn = this.block.length;
	}

	/** A line above the status block. */
	log(line: string) {
		if (!this.tty) return void console.log(line);
		process.stdout.write(`${this.clear()}${line}\n${this.block.join('\n')}${this.block.length ? '\n' : ''}`);
		this.drawn = this.block.length;
	}

	/** Stop redrawing: the last block stays on screen. */
	freeze() {
		this.drawn = 0;
		this.block = [];
	}

	onKey(handler: (key: Key) => void) {
		if (!this.tty || !process.stdin.isTTY) return;
		process.stdin.setRawMode(true);
		process.stdin.resume();
		this.keyHandler = (data) => {
			const key = KEYS[data.toString()];
			if (key) handler(key);
		};
		process.stdin.on('data', this.keyHandler);
	}

	close() {
		if (this.keyHandler) {
			process.stdin.off('data', this.keyHandler);
			process.stdin.setRawMode(false);
			process.stdin.pause();
			this.keyHandler = null;
		}
	}

	/** Read one line (for the prod confirmation), before raw mode starts. */
	async ask(question: string): Promise<string> {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		try {
			return (await rl.question(question)).trim();
		} finally {
			rl.close();
		}
	}

	private clear() {
		return this.drawn ? `\u001b[${this.drawn}F\u001b[0J` : '';
	}
}

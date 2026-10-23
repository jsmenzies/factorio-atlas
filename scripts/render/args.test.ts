import { describe, expect, test } from 'bun:test';
import { commandLine, defaultArgs, parseArgs, resolveArgs, resumeArgs, UsageError, type RenderArgs } from './args.js';

const defaults = defaultArgs({ threads: 16, ramMb: 20_000 });
const parse = (s: string) => parseArgs(s.split(' ').filter(Boolean), '/raw');
const resolved = (s: string) => resolveArgs(parse(s).given, defaults);

describe('render args', () => {
	test('--top N and --refresh-top', () => {
		const a = resolved('--from-clone /m --next 50 --top 1000 --refresh-top');
		expect(a).toMatchObject({ clone: '/m', next: 50, top: 1000, refreshTop: true });
		expect(commandLine(a)).toBe('--from-clone /m --next 50 --top 1000 --refresh-top --workers 8');
		expect(resolved('--from-clone /m --ids a,b --top 10')).toMatchObject({ ids: ['a', 'b'], top: 10, refreshTop: false });
		expect(() => resolved('--from-clone /m --refresh-top')).toThrow(UsageError);
		expect(() => resolved('--from-clone /m --top 0')).toThrow(UsageError);
		expect(() => resolved('--from-clone /m --top')).toThrow(UsageError);
	});

	test('without --top nothing changes', () => {
		const a = resolved('--from-clone /m --next 400 --upload prod --workers 1');
		expect(a).toMatchObject({ next: 400, top: null, refreshTop: false, upload: 'prod', workers: 1 });
		expect(commandLine(a)).toBe('--from-clone /m --next 400 --upload prod --workers 1');
	});

	test('--resume keeps --top, but a finished batch resumes with exactly its picks', () => {
		const base = resolved('--from-clone /m --next 3 --top 100 --refresh-top');
		const unfinished = resumeArgs({ args: base, batch: { next: 3, picked: ['a'], complete: false } }, 'r1', {});
		expect(unfinished.args).toMatchObject({ next: 3, top: 100, refreshTop: false });
		const finished = resumeArgs({ args: base, batch: { next: 3, picked: ['a', 'b', 'c'], complete: true } }, 'r1', {});
		expect(finished.args).toMatchObject({ ids: ['a', 'b', 'c'], next: null, top: null, batchOf: 3 });
		const ids = resolved('--from-clone /m --ids a --top 5');
		expect(resumeArgs({ args: ids }, 'r2', {}).args).toMatchObject({ ids: ['a'], top: 5 });
	});

	test('a new selection on --resume replaces --top; runs recorded before it resume without it', () => {
		const base = resolved('--from-clone /m --next 3 --top 100');
		expect(resumeArgs({ args: base }, 'r1', parse('--next 7').given).args).toMatchObject({ next: 7, top: null });
		expect(resumeArgs({ args: base }, 'r1', parse('--top 20').given).args).toMatchObject({ next: null, top: 20 });
		const old = { ...resolved('--from-clone /m --next 3') } as Partial<RenderArgs>;
		delete old.top;
		delete old.refreshTop;
		expect(resumeArgs({ args: old as RenderArgs }, 'r0', {}).args).toMatchObject({ next: 3, top: null, refreshTop: false });
	});

	test('thumbnails: on by default, --no-thumbs and --thumb-jobs; runs recorded before them resume with them on', () => {
		expect(resolved('--from-clone /m')).toMatchObject({ thumbs: true, thumbJobs: 1 });
		const off = resolved('--from-clone /m --no-thumbs --thumb-jobs 2');
		expect(off).toMatchObject({ thumbs: false, thumbJobs: 2 });
		expect(commandLine(off)).toBe('--from-clone /m --no-thumbs --workers 8');
		expect(resumeArgs({ args: off }, 'r1', {}).args).toMatchObject({ thumbs: false, thumbJobs: 2 });
		const old = { ...resolved('--from-clone /m') } as Partial<RenderArgs>;
		delete old.thumbs;
		delete old.thumbJobs;
		expect(resumeArgs({ args: old as RenderArgs }, 'r0', {}).args).toMatchObject({ thumbs: true, thumbJobs: 1 });
		expect(() => resolved('--from-clone /m --thumb-jobs 0')).toThrow(UsageError);
	});
});

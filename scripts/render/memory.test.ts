import { describe, expect, test } from 'bun:test';
import { defaultArgs, parseArgs, resolveArgs } from './args.js';
import {
	admit,
	defaultReserveMb,
	maxWorkers,
	memEstimateMb,
	pageGrowthMb,
	pagePeakMb,
	parseMeminfo,
	parseStatus,
	type AdmissionInput
} from './memory.js';

const MEMINFO = `MemTotal:       24576000 kB
MemFree:         5742000 kB
MemAvailable:    8073000 kB
Buffers:           12000 kB
Cached:          6951000 kB
SwapTotal:       6291456 kB
SwapFree:        6230764 kB
Shmem:           4484000 kB
`;

describe('parseMeminfo', () => {
	test('reads MB', () => {
		expect(parseMeminfo(MEMINFO)).toEqual({ totalMb: 24000, availableMb: 7884, shmemMb: 4379, swapFreeMb: 6085 });
	});

	test('null without MemAvailable', () => {
		expect(parseMeminfo('MemTotal: 1024 kB\nMemFree: 512 kB\n')).toBeNull();
		expect(parseMeminfo('')).toBeNull();
	});

	test('does not take a field for one with a longer name', () => {
		const m = parseMeminfo('MemTotal: 2048 kB\nMemAvailable: 1024 kB\nShmemHugePages: 4096 kB\nShmem: 1024 kB\n');
		expect(m?.shmemMb).toBe(1);
	});
});

describe('parseStatus', () => {
	test('reads RSS and its parts', () => {
		const s = parseStatus('Name:\tbun\nVmRSS:\t 1121360 kB\nRssAnon:\t  737092 kB\nRssFile:\t  141948 kB\nRssShmem:\t  242320 kB\n');
		expect(s).toEqual({ rssMb: 1121360 / 1024, anonMb: 737092 / 1024, shmemMb: 242320 / 1024 });
	});

	test('a kernel without the parts falls back to VmRSS', () => {
		expect(parseStatus('VmRSS:\t2048 kB\n')).toEqual({ rssMb: 2, anonMb: 2, shmemMb: 0 });
		expect(parseStatus('Name:\tzombie\n')).toBeNull();
	});
});

describe('admit', () => {
	const base: AdmissionInput = {
		peakMb: 1500,
		workerMb: 300,
		workers: [
			{ footprintMb: 300, peakMb: null },
			{ footprintMb: 1000, peakMb: 1500 }
		],
		inFlight: 1,
		budgetMb: 10_000,
		availableMb: 10_000,
		reserveMb: 2048
	};

	test('starts when budget and free memory allow', () => {
		expect(admit(base)).toEqual({ ok: true });
	});

	test('counts what pages in flight may still grow against MemAvailable', () => {
		// Grows: 500 (in flight, 1000 → 1500) + 1200 (new page on a 300 MB worker) = 1700.
		expect(admit({ ...base, availableMb: 2048 + 1700 })).toEqual({ ok: true });
		expect(admit({ ...base, availableMb: 2048 + 1699 })).toEqual({
			ok: false,
			why: 'memory',
			needMb: 1700,
			availableMb: 3747,
			reserveMb: 2048
		});
	});

	test('a worker past its estimate counts at what it holds, and has nothing left to grow', () => {
		const workers = [
			{ footprintMb: 300, peakMb: null },
			{ footprintMb: 2600, peakMb: 1500 }
		];
		expect(admit({ ...base, workers, availableMb: 2048 + 1200 }).ok).toBe(true);
		// Budget: 300 + 2600 + 1200 = 4100.
		expect(admit({ ...base, workers, budgetMb: 4100 }).ok).toBe(true);
		expect(admit({ ...base, workers, budgetMb: 4099 })).toEqual({ ok: false, why: 'budget', needMb: 4100, limitMb: 4099 });
	});

	test('an idle worker that already holds the memory needs none more', () => {
		const workers = [
			{ footprintMb: 1600, peakMb: null },
			{ footprintMb: 1500, peakMb: 1500 }
		];
		expect(admit({ ...base, workers, workerMb: 1600, availableMb: 2048 }).ok).toBe(true);
	});

	test('with nothing in flight a page always starts', () => {
		expect(admit({ ...base, inFlight: 0, availableMb: 100, budgetMb: 1 })).toEqual({ ok: true });
	});

	test('without MemAvailable only the budget applies', () => {
		expect(admit({ ...base, availableMb: null }).ok).toBe(true);
		expect(admit({ ...base, availableMb: null, budgetMb: 2000 }).ok).toBe(false);
	});
});

describe('pagePeakMb', () => {
	test('a fresh worker grows to the estimate, a warm one by the page', () => {
		expect(pagePeakMb(5000, 100)).toBe(memEstimateMb(5000));
		expect(pagePeakMb(5000, 2000)).toBe(2000 + pageGrowthMb(5000));
	});
});

describe('limits', () => {
	test('reserve: the larger of 2 GB and 10% of RAM', () => {
		expect(defaultReserveMb(8192)).toBe(2048);
		expect(defaultReserveMb(24_000)).toBe(2400);
		expect(defaultReserveMb(65_536)).toBe(6554);
	});

	test('workers that fit', () => {
		expect(maxWorkers(24_000, 2400, memEstimateMb(0))).toBe(16);
		expect(maxWorkers(8192, 2048, memEstimateMb(0))).toBe(4);
		expect(maxWorkers(1024, 2048, memEstimateMb(0))).toBe(1);
	});

	test('--mem-reserve-mb, with a default from RAM', () => {
		const defaults = defaultArgs({ threads: 16, ramMb: 24_000 });
		expect(resolveArgs(parseArgs(['--from-clone', '/m'], '').given, defaults).memReserveMb).toBe(2400);
		expect(resolveArgs(parseArgs(['--from-clone', '/m', '--mem-reserve-mb', '4096'], '').given, defaults).memReserveMb).toBe(4096);
	});
});

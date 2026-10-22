import { describe, expect, test } from 'bun:test';
import { BUSY_RESULT, isBusy, orBusy, retryBusy } from './busy.js';

describe('busy', () => {
	test('only lock errors and a dropped local call count', () => {
		expect(isBusy(new Error('D1_ERROR: Failed to get session commit token: internal error; reference = x'))).toBe(true);
		expect(isBusy(new Error('database is locked: SQLITE_BUSY'))).toBe(true);
		expect(isBusy(new TypeError('fetch failed'))).toBe(true);
		expect(isBusy(new Error('D1_ERROR: no such table: render_uploads'))).toBe(false);
		expect(isBusy(new Error('fetch failed because of x'))).toBe(false);
	});

	test('retries busy errors, not others', async () => {
		let n = 0;
		expect(
			await retryBusy(async () => {
				if (++n < 3) throw new Error('SQLITE_BUSY');
				return 'ok';
			})
		).toBe('ok');
		expect(n).toBe(3);
		n = 0;
		await expect(
			retryBusy(async () => {
				n++;
				throw new Error('no such table');
			})
		).rejects.toThrow('no such table');
		expect(n).toBe(1);
	});

	test('orBusy: the value, BUSY_RESULT once the lock outlasts the tries, other errors thrown', async () => {
		expect(await orBusy(async () => 7)).toBe(7);
		let n = 0;
		expect(
			await orBusy(async () => {
				n++;
				throw new Error('D1_ERROR: Failed to get session commit token: internal error');
			}, 2)
		).toBe(BUSY_RESULT);
		expect(n).toBe(2);
		await expect(orBusy(async () => Promise.reject(new Error('no such table')))).rejects.toThrow('no such table');
	});
});

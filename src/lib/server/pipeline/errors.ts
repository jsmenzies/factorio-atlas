import { Data } from 'effect';

export class FetchError extends Data.TaggedError('FetchError')<{
	readonly url: string;
	readonly status?: number;
	readonly cause?: unknown;
}> {}

export class NotFoundError extends Data.TaggedError('NotFoundError')<{
	readonly id: string;
}> {}

export class RecordParseError extends Data.TaggedError('RecordParseError')<{
	readonly id: string;
	readonly cause: unknown;
}> {}

export class BlueprintDecodeError extends Data.TaggedError('BlueprintDecodeError')<{
	readonly reason: string;
	readonly cause?: unknown;
}> {}

export class StorageError extends Data.TaggedError('StorageError')<{
	readonly op: string;
	readonly cause: unknown;
}> {}

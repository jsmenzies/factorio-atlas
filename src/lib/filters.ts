/** Search filters that take several values (`?makes=a&makes=b`): a print must match every one. */
export const MULTI_FILTERS = ['makes', 'takes', 'uses', 'recipe', 'module', 'version', 'tag'] as const;
export type MultiFilter = (typeof MULTI_FILTERS)[number];

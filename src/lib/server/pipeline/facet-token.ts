/**
 * SQL for one keyword token in a print's FTS `facets` column, for the tokens written outside `upsert`
 * (`render_yes` by render-flags.ts, `folded_yes` by fold.ts). Tokens go first, so facetText's cap never
 * cuts them, and the guards make a repeat harmless.
 */

/** `' ' || facets || ' '` holds the token as a whole word. */
export const hasToken = (token: string) => `instr(' ' || facets || ' ', ' ${token} ') > 0`;

/** The SET clause adding the token. */
export const addToken = (token: string) => `facets = '${token} ' || facets`;

/** The SET clause removing the token. */
export const removeToken = (token: string) => `facets = trim(replace(' ' || facets || ' ', ' ${token} ', ' '))`;

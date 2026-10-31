/** A caught error's message, or the thrown value as text: what logs and answers show for anything caught. */
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

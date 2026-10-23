/**
 * A plain left click on a link the page handles itself (e.g. picking a book page in place).
 * Clicks with a modifier or another button follow the link as usual: new tab, new window.
 */
export const plainClick = (e: MouseEvent) => e.button === 0 && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);

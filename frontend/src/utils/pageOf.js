/**
 * The part of an address that says which *page* it is.
 *
 * What a pane keys its screen on, and therefore what decides whether the screen
 * is replaced or left exactly as it is. Walking into another folder is another
 * page and the folder view wants a new instance for it — it captures where it is
 * on the way in. The two things dropped here are not:
 *
 *  - **the query**, because a screen rewriting its own is the same screen. A
 *    comparison whose two sides are swapped over is the same comparison, saying
 *    itself the other way round, and it holds lines taken across and not yet
 *    saved that exist nowhere else. Keyed on the whole address it was rebuilt
 *    from the file and threw all of that away.
 *  - **the fragment**, because it is *where in this page*, by definition. The
 *    settings write one when a theme is chosen from the list beside them, and it
 *    was read as another page: the screen was torn down and built again, so the
 *    preferences lost the filter somebody had typed, the expiry they were
 *    halfway through, and the switches they had changed and not yet saved. What
 *    they saw of it was the header jumping.
 *
 * @param {string} address an address, with or without a query and a fragment
 * @returns {string} the path alone
 */
export const pageOf = (address) => String(address || '').split(/[?#]/)[0];

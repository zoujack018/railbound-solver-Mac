/* Worker creation — uses Vite's built-in worker bundling.
 * The actual solver code lives in railbound-worker.js,
 * which imports rules from the shared railbound-rules.js.
 * No more duplicated template strings.
 */

export function createSolverWorkerUrl() {
  return new URL("./railbound-worker.js", import.meta.url);
}

// Compatibility alias for callers from the pre-module-Worker migration.
export const createWorkerBlob = createSolverWorkerUrl;

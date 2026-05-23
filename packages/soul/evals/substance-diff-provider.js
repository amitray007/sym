/**
 * promptfoo custom provider for the substance-diff guard eval.
 *
 * Calls checkSubstanceDiff with the `original` and `rewritten` vars and
 * returns the JSON-serialised SubstanceDiffResult as the output string.
 *
 * Usage in substance-diff.yaml:
 *   providers:
 *     - id: "file://./substance-diff-provider.js"
 */

// ESM-compatible dynamic import so this works as a promptfoo provider script.
export async function callApi(prompt, { vars }) {
  const { checkSubstanceDiff } = await import('../dist/index.js');
  const result = checkSubstanceDiff(vars.original ?? '', vars.rewritten ?? '');
  return { output: JSON.stringify(result) };
}

// Helpers for the voice evals (decision 044). Not an eval file.

export const LIST_LINE = /^\s*(?:\d+[.)]|[•\-*☐✅])\s+\S/;

export function lines(message: string | undefined): string[] {
  return (message ?? "").split("\n").filter((line) => line.trim().length > 0);
}

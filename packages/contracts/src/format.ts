/** Credits in the unit the reference product shows (its "credits" are our microcredits): 5,000 · 29.92M. */
export function formatCredits(micro: number | bigint): string {
  const n = Number(micro);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return Math.round(n).toLocaleString("en-US");
}

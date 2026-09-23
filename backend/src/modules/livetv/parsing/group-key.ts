/** Comparison key for a restriction match: whitespace and case both fold,
 *  since a provider spells the same category inconsistently across entries.
 *  Accents are left alone; folding them risks merging two languages' names.
 *  Shared by the access and channels services so both sides of the
 *  restriction (who it applies to, which rows it hides) agree on one group. */
export function foldGroupKey(name: string): string {
  return name.trim().toLowerCase();
}

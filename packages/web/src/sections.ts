/** Which result sections are collapsed — a set of section keys, empty by default so every section starts open. */
export type Collapsed = ReadonlySet<string>;

export const NONE_COLLAPSED: Collapsed = new Set();

export function toggleSection(collapsed: Collapsed, key: string): Collapsed {
  const next = new Set(collapsed);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export const collapseAll = (keys: string[]): Collapsed => new Set(keys);

export const expandAll = (): Collapsed => NONE_COLLAPSED;

/** True when every listed section is collapsed, so the one text action reads "Expand all". */
export const allCollapsed = (collapsed: Collapsed, keys: string[]): boolean => keys.length > 0 && keys.every((key) => collapsed.has(key));

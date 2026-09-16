/** Message formatting shared by checks that list offending names — long lists are truncated, never dropped. */
const MAX_LISTED = 5;

export function listSome(names: string[]): string {
  return names.slice(0, MAX_LISTED).join(", ") + (names.length > MAX_LISTED ? ` (+${names.length - MAX_LISTED} more)` : "");
}

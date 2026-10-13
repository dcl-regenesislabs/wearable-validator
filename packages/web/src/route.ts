/** The page's only URL state: `?urn=<urn>`, the catalyst item on screen. */
export function urnFrom(search: string): string | null {
  return new URLSearchParams(search).get("urn")?.trim() || null;
}

export function urnUrl(urn: string | null): string {
  return urn ? `/?${new URLSearchParams({ urn })}` : "/";
}

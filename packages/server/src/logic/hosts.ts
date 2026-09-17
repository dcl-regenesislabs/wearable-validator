/** Which Host headers this server answers to: the bind address, loopback names and PUBLIC_HOSTS. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

const bareHost = (host: string): string => host.replace(/^\[|\]$/g, "").toLowerCase();

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(bareHost(host));
}

export function hostAllowed(header: string | undefined | null, configured?: string, publicHosts: string[] = []): boolean {
  if (!header) return false;
  try {
    const { hostname } = new URL(`http://${header}`);
    const bare = bareHost(hostname);
    return LOOPBACK.has(bare) || (configured !== undefined && bare === bareHost(configured)) || publicHosts.some((host) => bareHost(host) === bare);
  } catch {
    return false;
  }
}

/** PUBLIC_HOSTS as a list: comma-separated, blanks dropped. */
export function parseHostList(value: string | undefined): string[] {
  return (value ?? "").split(",").map((name) => name.trim()).filter(Boolean);
}

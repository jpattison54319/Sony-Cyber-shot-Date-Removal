export const DEFAULT_SITE_ORIGIN = "https://sony-cyber-shot-date-removal.vercel.app";

export function resolveMetadataBase(vercelProductionDomain: string | undefined): URL {
  const domain = vercelProductionDomain?.trim();
  if (!domain) return new URL(DEFAULT_SITE_ORIGIN);

  try {
    const url = new URL(`https://${domain}`);
    const isBareDomain =
      url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password;
    if (!isBareDomain) return new URL(DEFAULT_SITE_ORIGIN);
    return url;
  } catch {
    return new URL(DEFAULT_SITE_ORIGIN);
  }
}

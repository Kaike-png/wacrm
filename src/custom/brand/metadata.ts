import type { Metadata } from 'next';
import { brand } from './config';

/**
 * Brand-derived document metadata for the root layout (core patch
 * P-003). Browser title: "<page> — <name>", default "<name>".
 * `description` comes from the caller (the localized
 * `Metadata.description`, which the fork's i18n layer rebrands).
 */
export function brandMetadata(description: string): Metadata {
  let metadataBase: URL | undefined;
  try {
    metadataBase = brand.url ? new URL(brand.url) : undefined;
  } catch {
    console.warn(
      `[brand] NEXT_PUBLIC_APP_URL is not a valid URL: ${brand.url}`
    );
  }

  return {
    title: { default: brand.name, template: `%s — ${brand.name}` },
    applicationName: brand.name,
    description,
    metadataBase,
    openGraph: {
      siteName: brand.name,
      title: brand.name,
      description,
      type: 'website',
      ...(brand.url ? { url: brand.url } : {}),
    },
  };
}

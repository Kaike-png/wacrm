import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { ImageResponse } from 'next/og';
import { brand, brandInitial } from './config';

/**
 * Favicon renderer used by `src/app/icon.tsx` (core patch P-003).
 *
 * - `brand.faviconUrl` set → that image, fitted into the icon box:
 *     * a path ("/brand/favicon.png") is read from `public/` at render
 *       time (this is why icon.tsx runs on the Node.js runtime);
 *     * an absolute http(s) URL is fetched by the renderer.
 * - otherwise → the generated mark (primary square + chat glyph or the
 *   name's initial), identical to upstream's icon by default.
 */

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

async function faviconSrc(url: string): Promise<string | null> {
  if (/^https?:\/\//i.test(url)) return url;
  const mime = MIME[extname(url).toLowerCase()];
  if (!mime) {
    console.warn(
      `[brand] unsupported favicon type: ${url} — using generated mark`
    );
    return null;
  }
  const publicDir = join(process.cwd(), 'public');
  const file = normalize(join(publicDir, url));
  if (!file.startsWith(publicDir)) return null; // no escaping public/
  try {
    const data = await readFile(file);
    return `data:${mime};base64,${data.toString('base64')}`;
  } catch {
    console.warn(
      `[brand] favicon not found at public${url} — using generated mark`
    );
    return null;
  }
}

export async function renderBrandIcon(size: { width: number; height: number }) {
  const src = brand.faviconUrl ? await faviconSrc(brand.faviconUrl) : null;

  if (src) {
    return new ImageResponse(
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt="" width={size.width} height={size.height} />,
      { ...size }
    );
  }

  const { primary, onPrimary } = brand.colors;
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: primary,
        borderRadius: Math.round(size.width * 0.1875),
        color: onPrimary,
        fontSize: Math.round(size.width * 0.625),
        fontWeight: 700,
      }}
    >
      {brand.markStyle === 'initial' ? (
        brandInitial()
      ) : (
        <svg
          width={Math.round(size.width * 0.625)}
          height={Math.round(size.height * 0.625)}
          viewBox="0 0 24 24"
          fill="none"
          stroke={onPrimary}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      )}
    </div>,
    { ...size }
  );
}

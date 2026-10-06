import { MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { brand, brandInitial } from './config';

/**
 * Brand mark (the square logo) and lockup (mark + name).
 *
 * Server- and client-safe (no hooks). With no logo configured it renders
 * exactly the markup upstream used in the sidebar (primary-coloured
 * rounded square + chat glyph), so the default look is unchanged.
 */

const SIZES = {
  sm: { box: 'h-8 w-8 rounded-lg', icon: 'h-4 w-4', text: 'text-sm' },
  md: { box: 'h-10 w-10 rounded-xl', icon: 'h-5 w-5', text: 'text-base' },
} as const;

export type BrandMarkSize = keyof typeof SIZES;

export function BrandMark({
  size = 'sm',
  className,
}: {
  size?: BrandMarkSize;
  className?: string;
}) {
  const s = SIZES[size];

  if (brand.logoUrl) {
    return (
      // A plain <img>: the logo may be an SVG or an external URL, and
      // next/image would need remotePatterns config per deployment.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={brand.logoUrl}
        alt={brand.name}
        className={cn(s.box, 'shrink-0 object-contain', className)}
      />
    );
  }

  return (
    <div
      aria-hidden
      className={cn(
        'bg-primary text-primary-foreground flex shrink-0 items-center justify-center',
        s.box,
        className
      )}
    >
      {brand.markStyle === 'initial' ? (
        <span className={cn('leading-none font-semibold', s.text)}>
          {brandInitial()}
        </span>
      ) : (
        <MessageSquare className={s.icon} />
      )}
    </div>
  );
}

export function BrandLockup({
  size = 'sm',
  className,
}: {
  size?: BrandMarkSize;
  className?: string;
}) {
  return (
    <span className={cn('flex items-center gap-2', className)}>
      <BrandMark size={size} />
      <span className={cn('text-foreground font-semibold', SIZES[size].text)}>
        {brand.name}
      </span>
    </span>
  );
}

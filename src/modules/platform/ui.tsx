/**
 * Small presentational pieces of the platform panel (no hooks, so they
 * render in server and client components alike).
 */
import { Badge } from '@/components/ui/badge';
import { formatCnpj, formatCpf } from '@/modules/br/documents';

const STATUS_STYLE: Record<string, string> = {
  trial: 'border-sky-500/40 bg-sky-500/10 text-sky-300',
  active: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  past_due: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  suspended: 'border-red-500/40 bg-red-500/10 text-red-300',
  cancelled: 'border-zinc-500/40 bg-zinc-500/10 text-zinc-300',
  // WhatsApp connection
  connected: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  pending: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  error: 'border-red-500/40 bg-red-500/10 text-red-300',
  disconnected: 'border-zinc-500/40 bg-zinc-500/10 text-zinc-300',
};

export function StatusPill({ value, label }: { value: string; label: string }) {
  return (
    <Badge
      variant="outline"
      className={STATUS_STYLE[value] ?? ''}
      data-status={value}
    >
      {label}
    </Badge>
  );
}

/** CPF (11 digits) or CNPJ (14 characters) with mask; anything else as stored. */
export function formatTaxIdAuto(value: string | null | undefined): string {
  if (!value) return '';
  if (value.length === 11) return formatCpf(value);
  if (value.length === 14) return formatCnpj(value);
  return value;
}

'use client';

/**
 * Number input that accepts what a Brazilian types (`1.500,50`, `1500,5`)
 * as well as `1500.50`, and reports a plain number. `type="number"`
 * rejects the comma in browsers with an English UI and reads `1.500` as
 * 1.5, so money fields use this instead (docs/LOCALIZATION.md).
 *
 * Keeps the typed text while focused (so `1500,` is not reformatted
 * mid-typing) and re-syncs from `value` when the field is not being edited.
 */
import { useState, type ComponentProps } from 'react';

import { Input } from '@/components/ui/input';

import { parseLocaleNumber, toLocaleInputNumber } from './format';

type Props = Omit<
  ComponentProps<typeof Input>,
  'type' | 'value' | 'onChange' | 'defaultValue'
> & {
  value: number | null | undefined;
  onValueChange: (value: number | null) => void;
};

export function LocaleNumberInput({
  value,
  onValueChange,
  onFocus,
  onBlur,
  ...rest
}: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Input
      {...rest}
      type="text"
      inputMode="decimal"
      value={draft ?? toLocaleInputNumber(value)}
      onFocus={(e) => {
        setDraft(toLocaleInputNumber(value));
        onFocus?.(e);
      }}
      onChange={(e) => {
        setDraft(e.target.value);
        onValueChange(parseLocaleNumber(e.target.value));
      }}
      onBlur={(e) => {
        setDraft(null);
        onBlur?.(e);
      }}
    />
  );
}

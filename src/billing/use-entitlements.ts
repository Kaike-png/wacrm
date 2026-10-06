'use client';

/**
 * Client side of the plan system (fork, docs/PLANS.md).
 *
 *   const { entitlements } = useEntitlements();       // plan + limits + usage
 *   const planLimitMessage = usePlanLimitMessage();
 *   toast.error(planLimitMessage(err) ?? genericMessage);
 *
 * Reads `billing_my_entitlements()` (members only, migration 907). The UI
 * only informs; the database and the server enforce.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { createBrowserSupabase } from '@/custom/core/client';

import { limitContextOf, planLimitFeature, planLimitMessage } from './errors';
import type { Entitlements } from './features';
import type { UsageReportView } from './usage-types';

export function useEntitlements(): {
  entitlements: Entitlements | null;
  loading: boolean;
  reload: () => Promise<void>;
} {
  const [entitlements, setEntitlements] = useState<Entitlements | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchEntitlements = useCallback(async () => {
    const { data, error } = await createBrowserSupabase().rpc(
      'billing_my_entitlements'
    );
    return error ? null : ((data as Entitlements | null) ?? null);
  }, []);

  const reload = useCallback(async () => {
    const next = await fetchEntitlements();
    if (next) setEntitlements(next);
    setLoading(false);
  }, [fetchEntitlements]);

  useEffect(() => {
    let cancelled = false;
    fetchEntitlements().then((next) => {
      if (cancelled) return;
      if (next) setEntitlements(next);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchEntitlements]);

  return { entitlements, loading, reload };
}

/**
 * Message for a plan-limit refusal (DB error 53400, PlanLimitError or the
 * 403 JSON from the API), or null for any other error.
 */
export function usePlanLimitMessage(): (err: unknown) => string | null {
  const t = useTranslations('Custom.billing');
  return useCallback(
    (err: unknown) => {
      const feature = planLimitFeature(err);
      if (!feature) return null;
      return planLimitMessage(feature, limitContextOf(err), (key, values) =>
        t(key as never, values as never)
      );
    },
    [t]
  );
}

/** Usage report of the signed-in user's organization (billing_my_usage, 908). */
export function useUsage(): {
  usage: UsageReportView | null;
  loading: boolean;
} {
  const [usage, setUsage] = useState<UsageReportView | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    createBrowserSupabase()
      .rpc('billing_my_usage')
      .then(({ data, error }) => {
        if (cancelled) return;
        if (!error && data) setUsage(data as UsageReportView);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return { usage, loading };
}

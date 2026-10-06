/**
 * First-run setup wizard: steps and progress (fork, docs/ONBOARDING.md).
 *
 * "Criar conta" happens before (signup); the wizard has four numbered
 * steps and a final screen:
 *
 *   1 de 4 — Organização        name, language/format, time zone, currency
 *   2 de 4 — Dados da empresa   CPF/CNPJ, razão social, contact, address (optional)
 *   3 de 4 — Equipe             invite links (optional)
 *   4 de 4 — WhatsApp           manual connection (optional; advanced settings stay)
 *   Tudo pronto                 summary → dashboard
 *
 * Progress lives in `onboarding_progress` (migration 904). Pure module.
 */

export const ONBOARDING_STEPS = [
  'organization',
  'company',
  'team',
  'whatsapp',
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export type OnboardingScreen = OnboardingStep | 'done';

/** Steps that may be skipped ("Fazer depois"). The organization name is required. */
export const OPTIONAL_STEPS: ReadonlySet<OnboardingStep> = new Set([
  'company',
  'team',
  'whatsapp',
]);

export interface OnboardingProgress {
  current_step: OnboardingScreen;
  completed_steps: OnboardingStep[];
  skipped_steps: OnboardingStep[];
  completed_at: string | null;
}

export const NEW_PROGRESS: OnboardingProgress = {
  current_step: 'organization',
  completed_steps: [],
  skipped_steps: [],
  completed_at: null,
};

export function isOnboardingStep(value: unknown): value is OnboardingStep {
  return (
    typeof value === 'string' &&
    (ONBOARDING_STEPS as readonly string[]).includes(value)
  );
}

export function isOnboardingScreen(value: unknown): value is OnboardingScreen {
  return value === 'done' || isOnboardingStep(value);
}

/** 1-based position for "1 de 4"; `null` for the final screen. */
export function stepNumber(screen: OnboardingScreen): number | null {
  return screen === 'done' ? null : ONBOARDING_STEPS.indexOf(screen) + 1;
}

/** 0–100, counting a step as done once completed or skipped. */
export function progressPercent(progress: OnboardingProgress): number {
  if (progress.completed_at || progress.current_step === 'done') return 100;
  const finished = new Set([
    ...progress.completed_steps,
    ...progress.skipped_steps,
  ]);
  return Math.round((finished.size / ONBOARDING_STEPS.length) * 100);
}

export function nextScreen(screen: OnboardingScreen): OnboardingScreen {
  if (screen === 'done') return 'done';
  const i = ONBOARDING_STEPS.indexOf(screen);
  return i + 1 < ONBOARDING_STEPS.length ? ONBOARDING_STEPS[i + 1] : 'done';
}

export function previousScreen(
  screen: OnboardingScreen
): OnboardingScreen | null {
  if (screen === 'done') return ONBOARDING_STEPS[ONBOARDING_STEPS.length - 1];
  const i = ONBOARDING_STEPS.indexOf(screen);
  return i > 0 ? ONBOARDING_STEPS[i - 1] : null;
}

/** A step was finished: mark it done (and no longer skipped), move on. */
export function completeStep(
  progress: OnboardingProgress,
  step: OnboardingStep
): OnboardingProgress {
  return {
    ...progress,
    completed_steps: unique([...progress.completed_steps, step]),
    skipped_steps: progress.skipped_steps.filter((s) => s !== step),
    current_step: nextScreen(step),
  };
}

/** "Fazer depois": allowed on optional steps only. */
export function skipStep(
  progress: OnboardingProgress,
  step: OnboardingStep
): OnboardingProgress {
  if (!OPTIONAL_STEPS.has(step)) return progress;
  return {
    ...progress,
    skipped_steps: progress.completed_steps.includes(step)
      ? progress.skipped_steps
      : unique([...progress.skipped_steps, step]),
    current_step: nextScreen(step),
  };
}

/**
 * Mark onboarding complete — only once every required step is completed
 * ("Pular tudo" or ?step=done must not complete it early). Otherwise the
 * progress is returned pointing at the first required step still missing,
 * with completed_at untouched.
 */
export function finish(
  progress: OnboardingProgress,
  now: Date = new Date()
): OnboardingProgress {
  const missing = ONBOARDING_STEPS.find(
    (s) => !OPTIONAL_STEPS.has(s) && !progress.completed_steps.includes(s)
  );
  if (missing && !progress.completed_at)
    return { ...progress, current_step: missing };
  return {
    ...progress,
    current_step: 'done',
    completed_at: progress.completed_at ?? now.toISOString(),
  };
}

/**
 * Where to send someone opening /onboarding: the saved step, or the first
 * step not finished yet if the saved one is unknown.
 */
export function resumeScreen(progress: OnboardingProgress): OnboardingScreen {
  if (isOnboardingScreen(progress.current_step)) return progress.current_step;
  const finished = new Set([
    ...progress.completed_steps,
    ...progress.skipped_steps,
  ]);
  return ONBOARDING_STEPS.find((s) => !finished.has(s)) ?? 'done';
}

/**
 * Whether the dashboard should send this user to the wizard: only the
 * organization's owner, only while it is not completed, and never when
 * the table is missing (migration not applied → no gate).
 */
export function shouldRedirectToOnboarding({
  available,
  progress,
  isOwner,
}: {
  available: boolean;
  progress: OnboardingProgress | null;
  isOwner: boolean;
}): boolean {
  if (!available || !isOwner) return false;
  return !progress || !progress.completed_at;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

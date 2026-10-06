import { describe, expect, it } from 'vitest';

import {
  NEW_PROGRESS,
  ONBOARDING_STEPS,
  completeStep,
  finish,
  nextScreen,
  previousScreen,
  progressPercent,
  resumeScreen,
  shouldRedirectToOnboarding,
  skipStep,
  stepNumber,
} from './steps';

describe('onboarding steps', () => {
  it('has four numbered steps and a final screen ("1 de 4")', () => {
    expect(ONBOARDING_STEPS).toEqual([
      'organization',
      'company',
      'team',
      'whatsapp',
    ]);
    expect(ONBOARDING_STEPS.map(stepNumber)).toEqual([1, 2, 3, 4]);
    expect(stepNumber('done')).toBeNull();
  });

  it('walks forward and back', () => {
    expect(nextScreen('organization')).toBe('company');
    expect(nextScreen('whatsapp')).toBe('done');
    expect(nextScreen('done')).toBe('done');
    expect(previousScreen('organization')).toBeNull();
    expect(previousScreen('done')).toBe('whatsapp');
  });

  it('records completed and skipped steps and the progress', () => {
    let p = completeStep(NEW_PROGRESS, 'organization');
    expect(p).toMatchObject({
      current_step: 'company',
      completed_steps: ['organization'],
    });
    expect(progressPercent(p)).toBe(25);

    p = skipStep(p, 'company');
    expect(p).toMatchObject({
      current_step: 'team',
      skipped_steps: ['company'],
    });
    expect(progressPercent(p)).toBe(50);

    // Coming back and filling a skipped step un-skips it.
    p = completeStep({ ...p, current_step: 'company' }, 'company');
    expect(p.skipped_steps).toEqual([]);
    expect(p.completed_steps).toEqual(['organization', 'company']);

    p = finish(p, new Date('2026-10-05T12:00:00Z'));
    expect(p).toMatchObject({
      current_step: 'done',
      completed_at: '2026-10-05T12:00:00.000Z',
    });
    expect(progressPercent(p)).toBe(100);
    expect(finish(p, new Date('2027-01-01')).completed_at).toBe(
      '2026-10-05T12:00:00.000Z'
    );
  });

  it('never skips the organization step (its name is required)', () => {
    expect(skipStep(NEW_PROGRESS, 'organization')).toBe(NEW_PROGRESS);
  });

  it('resumes at the saved step', () => {
    expect(resumeScreen(NEW_PROGRESS)).toBe('organization');
    expect(resumeScreen({ ...NEW_PROGRESS, current_step: 'whatsapp' })).toBe(
      'whatsapp'
    );
    expect(
      resumeScreen({
        ...NEW_PROGRESS,
        current_step: 'bogus' as never,
        completed_steps: ['organization', 'company'],
      })
    ).toBe('team');
  });
});

describe('dashboard redirect', () => {
  const pending = { ...NEW_PROGRESS };
  const completed = finish(NEW_PROGRESS);

  it('sends only the owner of an unfinished organization', () => {
    expect(
      shouldRedirectToOnboarding({
        available: true,
        progress: null,
        isOwner: true,
      })
    ).toBe(true);
    expect(
      shouldRedirectToOnboarding({
        available: true,
        progress: pending,
        isOwner: true,
      })
    ).toBe(true);
    expect(
      shouldRedirectToOnboarding({
        available: true,
        progress: completed,
        isOwner: true,
      })
    ).toBe(false);
    expect(
      shouldRedirectToOnboarding({
        available: true,
        progress: null,
        isOwner: false,
      })
    ).toBe(false);
  });

  it('never redirects when the migration is missing', () => {
    expect(
      shouldRedirectToOnboarding({
        available: false,
        progress: null,
        isOwner: true,
      })
    ).toBe(false);
  });
});

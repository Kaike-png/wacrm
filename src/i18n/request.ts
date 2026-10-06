import { getRequestConfig } from 'next-intl/server';
// FORK-PATCH(P-002): layer fork-owned strings — docs/UPSTREAM_STRATEGY.md
import { withCustomMessages } from '@/custom/i18n/merge';

export default getRequestConfig(async () => {
  // Read the locale from the environment, defaulting to 'en'
  const locale = process.env.NEXT_PUBLIC_APP_LOCALE || 'en';

  let messages;
  try {
    messages = (await import(`../../messages/${locale}.json`)).default;
  } catch (error) {
    // Fallback to English if the dictionary for the requested locale doesn't exist yet
    messages = (await import(`../../messages/en.json`)).default;
  }

  return {
    locale,
    messages
  };
});

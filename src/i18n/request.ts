import { getRequestConfig } from 'next-intl/server';
// FORK-PATCH(P-002): layer fork-owned strings — docs/UPSTREAM_STRATEGY.md
import { withCustomMessages } from '@/custom/i18n/merge';
// FORK-PATCH(P-004): `pt-BR` spellings + regional defaults — docs/LOCALIZATION.md
import { APP_LOCALE_RAW, catalogueLocale, intlLocale, regionalDefaults } from '@/custom/locale/config';

export default getRequestConfig(async () => {
  // Read the locale from the environment, defaulting to 'en'
  // FORK-PATCH(P-004): default pt-BR; `pt`, `pt-BR`, `pt_BR` all load messages/pt.json
  const catalogue = catalogueLocale(APP_LOCALE_RAW);

  let messages;
  try {
    messages = (await import(`../../messages/${catalogue}.json`)).default;
  } catch (error) {
    // Fallback to English if the dictionary for the requested locale doesn't exist yet
    messages = (await import(`../../messages/en.json`)).default;
  }

  return {
    // FORK-PATCH(P-004): BCP 47 locale (`pt-BR`) for <html lang> and next-intl
    // formatting; deploy time zone so server and browser render the same.
    locale: intlLocale(APP_LOCALE_RAW),
    timeZone: regionalDefaults.timeZone,
    messages: withCustomMessages(catalogue, messages) // FORK-PATCH(P-002)
  };
});

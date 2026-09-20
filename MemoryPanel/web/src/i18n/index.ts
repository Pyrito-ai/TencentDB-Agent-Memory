/** English interface configuration for this deployment. */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { enUS } from './en-US';

const STORAGE_KEY = 'tdai-memory.lang';

function detectInitialLanguage(): string { return 'en-US'; }

export function changeLanguage(lang: string): void {
  void lang;
  i18n.changeLanguage('en-US');
  localStorage.setItem(STORAGE_KEY, 'en-US');
}

export function getCurrentLanguage(): string {
  return i18n.language || 'en-US';
}

i18n.use(initReactI18next).init({
  resources: {
    'en-US': { translation: enUS },
  },
  lng: detectInitialLanguage(),
  fallbackLng: 'en-US',
  interpolation: {
    escapeValue: false,
  },
  react: {
    useSuspense: false,
  },
});

export default i18n;

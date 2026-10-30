import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import {
  type Locale,
  getStoredLocale,
  storeLocale,
} from "./locale";
import { createTranslatorSync, type TFunction } from "./translator";

interface I18nContextValue {
  locale: Locale;
  t: TFunction;
  setLocale: (locale: Locale) => void;
  loading: boolean;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => getStoredLocale());

  const setLocale = useCallback((newLocale: Locale) => {
    storeLocale(newLocale);
    setLocaleState(newLocale);
  }, []);

  const t: TFunction = useMemo(() => createTranslatorSync(locale), [locale]);

  const value = useMemo(
    () => ({ locale, t, setLocale, loading: false }),
    [locale, t, setLocale]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useTranslation(): I18nContextValue {
  const ctx = useContext(I18nContext);
  // Fallback for when there is no provider (HMR, isolated tests): keep the
  // value referentially stable for a given locale, otherwise `t` is a brand
  // new function on every render and any effect depending on it re-runs,
  // which can turn a single state update into an infinite render loop.
  const fallbackLocale = getStoredLocale();
  const fallback = useMemo<I18nContextValue>(
    () => ({
      locale: fallbackLocale,
      t: createTranslatorSync(fallbackLocale),
      setLocale: storeLocale,
      loading: false,
    }),
    [fallbackLocale],
  );
  return ctx ?? fallback;
}

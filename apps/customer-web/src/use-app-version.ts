import { useCallback, useEffect, useRef, useState } from 'react';

declare const __MOVIX_BUILD_ID__: string;

export function useAppVersion() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const lastCheckedAt = useRef(0);
  const checkVersion = useCallback(async (force = false) => {
    if (import.meta.env.DEV || updateAvailable) return;
    const now = Date.now();
    if (!force && now - lastCheckedAt.current < 60_000) return;
    lastCheckedAt.current = now;
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}version.json`, { cache: 'no-store' });
      if (!response.ok) return;
      const result = await response.json() as { buildId?: string };
      if (result.buildId && result.buildId !== __MOVIX_BUILD_ID__) setUpdateAvailable(true);
    } catch { /* 离线或部署切换期间保留当前页面，下一次再检查。 */ }
  }, [updateAvailable]);

  useEffect(() => {
    if (import.meta.env.DEV) return;
    const onVisible = () => { if (!document.hidden) void checkVersion(); };
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) void checkVersion(true); };
    const onPreloadError = (event: Event) => { event.preventDefault(); setUpdateAvailable(true); };
    void checkVersion();
    const timer = window.setInterval(onVisible, 5 * 60_000);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('vite:preloadError', onPreloadError);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('vite:preloadError', onPreloadError);
    };
  }, [checkVersion]);

  return updateAvailable;
}

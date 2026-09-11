(() => {
  'use strict';
  const state = { registration: null, deferredInstallPrompt: null };

  const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
  document.documentElement.dataset.appMode = isStandalone() ? 'standalone' : 'browser';

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', async () => {
      try {
        state.registration = await navigator.serviceWorker.register('./service-worker.js', { scope: './' });
        // Ask a waiting SW to become active on the next normal reload without interrupting an active reservation.
        state.registration.update().catch(() => {});
      } catch (err) {
        console.warn('SandLock PWA service worker registration failed:', err);
      }
    });
  }

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    state.deferredInstallPrompt = event;
    window.dispatchEvent(new CustomEvent('sandlock:install-ready'));
  });

  window.addEventListener('appinstalled', () => {
    state.deferredInstallPrompt = null;
    document.documentElement.dataset.appMode = 'standalone';
  });

  window.SandLockPWA = {
    isStandalone,
    getRegistration: async () => state.registration || (await navigator.serviceWorker?.ready).active,
    canPromptInstall: () => !!state.deferredInstallPrompt,
    install: async () => {
      const prompt = state.deferredInstallPrompt;
      if (!prompt) return { outcome: 'unavailable' };
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice?.outcome === 'accepted') state.deferredInstallPrompt = null;
      return choice;
    },
    showNotification: async (title, options={}) => {
      if (!('Notification' in window) || Notification.permission !== 'granted') return false;
      try {
        const reg = await navigator.serviceWorker.ready;
        await reg.showNotification(title, {
          icon: './icons/icon-192.png',
          badge: './icons/icon-96.png',
          ...options
        });
        return true;
      } catch {
        try { new Notification(title, options); return true; } catch { return false; }
      }
    }
  };
})();

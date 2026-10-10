type Config = {
  onSuccess?: (registration: ServiceWorkerRegistration) => void;
  onUpdate?: (registration: ServiceWorkerRegistration) => void;
};

function appScope() {
  // Rsbuild injects the same asset prefix used by the production HTML.
  const prefix = (process.env.ASSET_PREFIX || '').replace(/\/$/, '');
  return new URL(`${prefix}/`, window.location.href);
}

export function register(config?: Config) {
  if (!('serviceWorker' in navigator)) return;
  const scope = appScope();
  if (scope.origin !== window.location.origin) return;

  const registerWorker = () => {
    navigator.serviceWorker
      .register(new URL('service-worker.js', scope).href, {
        scope: scope.href,
        updateViaCache: 'none',
      })
      .then((registration) => {
        registration.onupdatefound = () => {
          const installingWorker = registration.installing;
          if (!installingWorker) return;
          installingWorker.onstatechange = () => {
            if (installingWorker.state !== 'installed') return;
            if (navigator.serviceWorker.controller) {
              config?.onUpdate?.(registration);
            } else {
              config?.onSuccess?.(registration);
            }
          };
        };
      })
      .catch((error) => {
        console.error('Error during service worker registration:', error);
      });
  };

  if (document.readyState === 'complete') {
    registerWorker();
  } else {
    window.addEventListener('load', registerWorker, { once: true });
  }
}

export function unregister() {
  if (!('serviceWorker' in navigator)) return;
  const scope = appScope();
  if (scope.origin !== window.location.origin) return;
  // getRegistration can return an ancestor worker belonging to another app.
  navigator.serviceWorker
    .getRegistration(new URL('service-worker.js', scope).href)
    .then((registration) => {
      if (registration?.scope === scope.href) return registration.unregister();
    })
    .catch((error) => console.error(error.message));
}

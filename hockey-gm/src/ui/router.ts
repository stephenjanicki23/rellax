import { useSyncExternalStore } from 'react';

export interface Route {
  page: string;
  param?: string;
  query: URLSearchParams;
}

function parse(): Route {
  const h = window.location.hash.replace(/^#\/?/, '');
  const [path, q] = h.split('?');
  const [page, param] = path.split('/');
  return { page: page || 'dashboard', param, query: new URLSearchParams(q ?? '') };
}

let current = parse();
const subs = new Set<() => void>();
window.addEventListener('hashchange', () => {
  current = parse();
  subs.forEach((f) => f());
  window.scrollTo(0, 0);
});

export function useRoute(): Route {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => current,
  );
}

export function navigate(path: string): void {
  window.location.hash = `#/${path.replace(/^\//, '')}`;
}

export const href = (path: string): string => `#/${path.replace(/^\//, '')}`;

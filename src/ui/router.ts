import { useEffect, useState, type MouseEvent } from 'react';

export function navigate(to: string): void {
  if (to === location.pathname + location.search) return;
  history.pushState(null, '', to);
  dispatchEvent(new PopStateEvent('popstate'));
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    addEventListener('popstate', on);
    return () => removeEventListener('popstate', on);
  }, []);
  return path;
}

/** Route in-app anchor clicks (including inside rendered Markdown) without a reload. */
export function interceptLinks(e: MouseEvent<HTMLElement>): void {
  const a = (e.target as HTMLElement).closest('a');
  const href = a?.getAttribute('href');
  if (!a || !href || !href.startsWith('/') || e.metaKey || e.ctrlKey || a.target === '_blank') return;
  e.preventDefault();
  navigate(href);
}

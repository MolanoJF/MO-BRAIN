import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, filesApi, type SpaceSummary } from './api.ts';

/**
 * The single app-wide Source selection.
 *
 * Before this file, `Files.tsx:181` held the selected Source in a local
 * `useState('')` that died on every page switch, and a grep across
 * `src/console` found zero uses of `createContext`, `useContext`, or
 * `localStorage` — there was no app-wide owner of "which Source am I looking
 * at" anywhere. This is that owner.
 *
 * Note on the wire vs. the UI: `filesApi.list()` still calls `GET /api/spaces`
 * and returns `SpaceSummary[]`, because a Space **is** a gbrain source
 * (`src/control/db/schema.ts:117`). Only the user-facing word changed to
 * "Source" — the wire path did not.
 */

const REMEMBERED_KEY = 'mobrain:console:current-source-id';

/**
 * Resolves which Source is selected. URL wins, then the remembered id, then
 * the first entry, then `null`.
 *
 * The rule that matters: a `fromUrl` or `remembered` id that no longer
 * appears in `spaces` is discarded and resolution falls through to the next
 * candidate — silently, with no error surfaced. A Source can be archived or
 * removed (`DELETE /api/sources/:sourceId`, see `src/control/routes/sources.ts`),
 * and a stale preference pointing at a dead Source is a stale preference, not
 * a failure: the operator lands on a working Source instead of an error
 * screen or an empty one.
 *
 * Pure on purpose. This repo has no DOM test harness (no happy-dom, jsdom, or
 * testing-library) — `pickSource` is exactly what can be tested about Source
 * selection without mounting anything.
 */
export function pickSource(
  spaces: SpaceSummary[],
  fromUrl: string | null,
  remembered: string | null,
): SpaceSummary | null {
  if (fromUrl !== null) {
    const found = spaces.find((s) => s.sourceId === fromUrl);
    if (found) return found;
  }
  if (remembered !== null) {
    const found = spaces.find((s) => s.sourceId === remembered);
    if (found) return found;
  }
  return spaces[0] ?? null;
}

/**
 * Every read and write is wrapped in try/catch: `localStorage` throws in a
 * private window, with site data blocked, and in some embedded webviews. A
 * console that white-screens because a preference could not be read is worse
 * than a console that simply forgets your Source, so a failed read returns
 * `null` (read as "no preference") and a failed write is swallowed.
 */
/**
 * After a reload the selection stays put if it still exists; otherwise it is
 * re-picked with the same rule as the first load (URL, remembered, first).
 */
export function pickAfterReload(
  spaces: SpaceSummary[],
  currentId: string | null,
  fromUrl: string | null,
  remembered: string | null,
): SpaceSummary | null {
  if (currentId !== null) {
    const kept = spaces.find((s) => s.sourceId === currentId);
    if (kept) return kept;
  }
  return pickSource(spaces, fromUrl, remembered);
}

export function readRememberedSource(): string | null {
  try {
    return localStorage.getItem(REMEMBERED_KEY);
  } catch {
    return null;
  }
}

export function rememberSource(sourceId: string | null): void {
  try {
    if (sourceId === null) localStorage.removeItem(REMEMBERED_KEY);
    else localStorage.setItem(REMEMBERED_KEY, sourceId);
  } catch {
    // No preference kept. The next load falls through to the first Source.
  }
}

type SourceState = {
  spaces: SpaceSummary[];
  current: SpaceSummary | null;
  setCurrent: (sourceId: string) => void;
  loading: boolean;
  error: string | null;
  /** Re-reads the Source list (after a rename, say) without losing the selection. */
  reload: () => Promise<void>;
};

const Ctx = createContext<SourceState | null>(null);

/**
 * Deliberately does NOT import the router and does NOT call
 * `history.pushState`. It takes the URL's source id as the `fromUrl` prop and
 * exposes `setCurrent` for a caller to react to; it never rewrites the
 * address bar itself. `AppShell` (Task 8) owns URL synchronisation. A state
 * container that also rewrites the address bar is two responsibilities in one
 * file and cannot be tested apart from a DOM — this one can, entirely through
 * `pickSource`.
 */
export function SourceProvider({
  fromUrl,
  children,
}: {
  fromUrl: string | null;
  children: ReactNode;
}) {
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  // `reload` is called from stale closures (page handlers), so it reads the live id from a ref.
  const currentIdRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    try {
      const body = await filesApi.list();
      setSpaces(body.spaces);
      const picked = pickAfterReload(body.spaces, currentIdRef.current, fromUrl, readRememberedSource());
      currentIdRef.current = picked?.sourceId ?? null;
      setCurrentId(picked?.sourceId ?? null);
      rememberSource(picked?.sourceId ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load Sources.');
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void reload().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setCurrent = (sourceId: string) => {
    currentIdRef.current = sourceId;
    setCurrentId(sourceId);
    rememberSource(sourceId);
  };

  const current = spaces.find((s) => s.sourceId === currentId) ?? null;

  return <Ctx.Provider value={{ spaces, current, setCurrent, loading, error, reload }}>{children}</Ctx.Provider>;
}

export function useSource(): SourceState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSource() called outside <SourceProvider>');
  return ctx;
}

import { useEffect, useRef } from 'react';
import { useRoute } from './router.ts';
import { SourceProvider, useSource } from './SourceContext.tsx';
import { resolveTab } from './settings/tabs.ts';
import { SettingsModal } from './settings/SettingsModal.tsx';
import { SettingsPanel } from './settings/SettingsPanel.tsx';
import { AccountBox } from './shell/AccountBox.tsx';
import { SourceSwitcher } from './shell/SourceSwitcher.tsx';
import { FileTree } from './shell/FileTree.tsx';
import { Editor } from './pages/Editor.tsx';
import { DesignSystem } from './pages/DesignSystem.tsx';

/**
 * The console's chrome, once a session is `ready`: the sidebar (account box,
 * Source switcher, file tree) and the editor, with settings layered over
 * the top as a modal rather than a route that replaces them.
 *
 * `SourceContext` deliberately does not touch the URL (see its own doc
 * comment) — this file is the caller it names as owning that. Every place
 * below that reads or writes `useRoute()`'s `route`/`navigate` is this
 * component doing that job; `SourceProvider`/`useSource` never do.
 */
export function AppShell({ isAdmin }: { isAdmin: boolean }) {
  const { route, navigate } = useRoute();
  const fromUrl = route.kind === 'editor' ? route.sourceId : null;

  return (
    <SourceProvider fromUrl={fromUrl}>
      <ShellBody isAdmin={isAdmin} route={route} navigate={navigate} />
    </SourceProvider>
  );
}

type RouteApi = ReturnType<typeof useRoute>;

export type SourceNav =
  | { action: 'none' }
  | { action: 'replace'; sourceId: string }
  | { action: 'push'; sourceId: string };

/**
 * The URL-sync decision, pulled out of `ShellBody`'s effect so it is
 * testable without a DOM (`test/unit/console-shell.test.ts`), matching the
 * `phaseFor` convention in `App.tsx`.
 *
 * `reflectedInitial`/`lastSourceId` are the caller's refs, passed in as
 * plain values rather than read here, so this stays pure: given the same
 * arguments it always returns the same action.
 *
 *  - Loading: nothing is resolved yet, so nothing navigates.
 *  - Not yet reflected, and the route isn't `editor` (settings, claim,
 *    design):
 *    the Source resolving is not this route's business — no navigation,
 *    whatever the resolved id is. (This is the branch the original bug
 *    got wrong: it skipped navigating here but did not also skip updating
 *    `lastSourceId`, so the *next* call saw a false "change".)
 *  - Not yet reflected, on the editor route, and the URL doesn't already
 *    name the resolved Source: `replace` — the user never chose this
 *    Source, so it must not become a back-button stop.
 *  - Not yet reflected, but the URL already names the resolved Source:
 *    nothing to do.
 *  - Already reflected, and the resolved id differs from the last one this
 *    function was told about: `push` — a real Source switch, dropping the
 *    open file and leaving a back-button trail to the previous Source.
 *  - Already reflected, id unchanged: nothing.
 */
export function sourceNavigation(args: {
  loading: boolean;
  routeKind: 'editor' | 'settings' | 'claim' | 'design';
  routeSourceId: string | null;
  resolvedSourceId: string | null;
  reflectedInitial: boolean;
  lastSourceId: string | null;
}): SourceNav {
  const { loading, routeKind, routeSourceId, resolvedSourceId, reflectedInitial, lastSourceId } = args;
  if (loading) return { action: 'none' };

  if (!reflectedInitial) {
    if (routeKind !== 'editor') return { action: 'none' };
    if (resolvedSourceId !== null && resolvedSourceId !== routeSourceId) {
      return { action: 'replace', sourceId: resolvedSourceId };
    }
    return { action: 'none' };
  }

  if (resolvedSourceId !== null && resolvedSourceId !== lastSourceId) {
    return { action: 'push', sourceId: resolvedSourceId };
  }
  return { action: 'none' };
}

function ShellBody({
  isAdmin, route, navigate,
}: {
  isAdmin: boolean;
  route: RouteApi['route'];
  navigate: RouteApi['navigate'];
}) {
  const { spaces, current, loading } = useSource();

  // The Source that resolution landed on (URL, then remembered, then first)
  // is reflected into the address bar exactly once, as a `replace` — the
  // user never chose it, so it must not become a back-button stop. Every
  // later Source change (the switcher itself) is a normal push, so the back
  // button can return to the Source the user was just on.
  //
  // Both refs are updated together, in this one effect, every time it runs
  // — never only on the branch that navigates. The previous version set
  // `reflectedInitial.current = true` without recording `lastSourceId` on
  // the settings-route branch, so a cold load of `/settings/*` resolved the
  // Source, correctly skipped the replace (a settings route isn't the
  // editor), but left `lastSourceId` stale at `null`. The very next render
  // then read the resolved id as "changed since last seen" and pushed the
  // editor route, closing the modal it had just opened. Deciding through
  // `sourceNavigation` — a single pure function fed the current refs and
  // returning the one action to take — makes that class of bug impossible:
  // there is no second, independently-updated ref left to fall out of sync.
  const reflectedInitial = useRef(false);
  const lastSourceId = useRef<string | null>(null);
  useEffect(() => {
    const resolvedSourceId = current?.sourceId ?? null;
    const nav = sourceNavigation({
      loading,
      routeKind: route.kind,
      routeSourceId: route.kind === 'editor' ? route.sourceId : null,
      resolvedSourceId,
      reflectedInitial: reflectedInitial.current,
      lastSourceId: lastSourceId.current,
    });
    if (loading) return;
    reflectedInitial.current = true;
    lastSourceId.current = resolvedSourceId;
    if (nav.action === 'replace') {
      navigate({ kind: 'editor', sourceId: nav.sourceId, path: null }, { replace: true });
    } else if (nav.action === 'push') {
      navigate({ kind: 'editor', sourceId: nav.sourceId, path: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.sourceId, loading]);

  const selectedPath = route.kind === 'editor' ? route.path : null;
  // The tree always reflects the resolved current Source (`useSource()`),
  // not the raw URL segment — `current` is the id `SourceContext` actually
  // found in `spaces`, while `route.sourceId` can briefly be a URL the
  // provider has not resolved yet (or a stale/unknown id it fell through).
  const sourceIdForTree = current?.sourceId ?? null;

  const openSettings = () => {
    navigate({ kind: 'settings', tab: resolveTab(null, isAdmin) });
  };
  const closeSettings = () => {
    navigate({ kind: 'editor', sourceId: current?.sourceId ?? null, path: selectedPath });
  };
  const selectFile = (path: string) => {
    navigate({ kind: 'editor', sourceId: current?.sourceId ?? null, path });
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <AccountBox onOpenSettings={openSettings} />
        <SourceSwitcher />
        <FileTree sourceId={sourceIdForTree} selectedPath={selectedPath} onSelect={selectFile} />
      </aside>
      <main className="main">
        {route.kind === 'design' ? (
          // The style guide replaces the editor rather than opening as a modal:
          // it is a full page of specimens, and it has to be reviewable beside
          // the real sidebar to show the primitives at their actual widths.
          <DesignSystem />
        ) : spaces.length === 0 && !loading ? (
          <p className="text-sm text-muted">
            {noSourcesMessage()}
            {isAdmin ? noSourcesAdminHint() : noSourcesMemberHint()}
          </p>
        ) : (
          <Editor sourceId={current?.sourceId ?? null} path={selectedPath} access={current?.access ?? null} />
        )}
      </main>
      {route.kind === 'settings' && (
        <SettingsModal label="Settings" onClose={closeSettings}>
          <SettingsPanel
            tab={resolveTab(route.tab, isAdmin)}
            isAdmin={isAdmin}
            onTab={(tab) => navigate({ kind: 'settings', tab })}
            onClose={closeSettings}
          />
        </SettingsModal>
      )}
    </div>
  );
}

/**
 * The empty-Sources copy, exported as named functions rather than inlined —
 * matching `staleNotice`/`treeErrorMessage` in `files/tree.ts` — so it is
 * unit-testable without a DOM.
 */
export function noSourcesMessage(): string {
  return 'No Sources you can reach.';
}

export function noSourcesAdminHint(): string {
  return ' Add one in Settings → Sources.';
}

export function noSourcesMemberHint(): string {
  return ' Ask an admin for access.';
}

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
  // later Source change (the switcher itself) goes through `onSwitchSource`
  // below with a normal push.
  const reflectedInitial = useRef(false);
  useEffect(() => {
    if (loading || reflectedInitial.current) return;
    reflectedInitial.current = true;
    if (route.kind !== 'editor') return;
    if (current !== null && current.sourceId !== route.sourceId) {
      navigate({ kind: 'editor', sourceId: current.sourceId, path: null }, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // A Source switch after that initial reflection is a real navigation: it
  // drops the open file (a path from one Source means nothing in another)
  // and is pushed, so the back button can return to the Source the user was
  // just on.
  const lastSourceId = useRef<string | null>(current?.sourceId ?? null);
  useEffect(() => {
    if (loading) return;
    const id = current?.sourceId ?? null;
    if (!reflectedInitial.current) {
      lastSourceId.current = id;
      return;
    }
    if (id !== null && id !== lastSourceId.current) {
      lastSourceId.current = id;
      navigate({ kind: 'editor', sourceId: id, path: null });
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
        {spaces.length === 0 && !loading ? (
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

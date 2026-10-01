import {
  EMPTY_TEXT,
  THEME_DAYLIGHT,
  THEME_DEFAULT,
  changeTheme,
  freshSession,
  present,
  resolveTree,
  selectAttachment,
  themeById,
  type RegionNode,
  type SessionRecord,
  type ThemeRecord,
  type WorkspaceView,
} from '@weave/tapestry';
import { useState } from 'react';
import { themeProperties } from './bindings';
import { Button } from '@/components/ui/button';
import { FIXTURES, type FixtureId } from './fixtures';
import { ApprovalPending } from './paint/approval';
import { ConversationThread } from './paint/conversation';
import { ProjectIndex } from './paint/project-index';

function themeOf(session: SessionRecord): ThemeRecord {
  const theme = themeById(session.theme_id);
  if (!theme) throw new Error(`unknown theme ${session.theme_id}`);
  return theme;
}

function Occupant({
  node,
  view,
  session,
  theme,
  onSelect,
}: {
  readonly node: RegionNode;
  readonly view: WorkspaceView;
  readonly session: SessionRecord;
  readonly theme: ThemeRecord;
  readonly onSelect: (label: string) => void;
}) {
  const presentation = present(view, session, node);
  if (presentation.kind === 'collapsed') {
    return (
      <p data-testid="drawer-collapsed" className="text-xs" style={{ color: 'var(--text-muted)' }}>
        collapsed
      </p>
    );
  }
  if (presentation.kind === 'empty') {
    return (
      <p className="text-sm" style={{ color: 'var(--condition-empty)' }}>
        <span className="mr-2 font-mono">{theme.mark['condition-empty']}</span>
        {presentation.text}
      </p>
    );
  }
  if (node.component === 'project.index@1' && (presentation.kind === 'index' || presentation.kind === 'omitted')) {
    return <ProjectIndex presentation={presentation} theme={theme} onSelect={onSelect} />;
  }
  if (node.component === 'conversation.thread@1' && (presentation.kind === 'observations' || presentation.kind === 'omitted')) {
    return <ConversationThread presentation={presentation} theme={theme} />;
  }
  if (node.component === 'approval.pending@1' && (presentation.kind === 'approval' || presentation.kind === 'omitted')) {
    return <ApprovalPending presentation={presentation} theme={theme} />;
  }
  return null;
}

export function Host() {
  const [fixture, setFixture] = useState<FixtureId>('omitted');
  const [session, setSession] = useState(() => freshSession('session-field', THEME_DEFAULT.id));
  const view = FIXTURES[fixture];
  const theme = themeOf(session);
  const tree = resolveTree(view, session);
  const project = view.project_name.status === 'disclosed' ? view.project_name.name : 'Project withheld';

  return (
    <div
      data-testid="shell"
      data-theme={theme.id}
      data-tree={JSON.stringify(tree)}
      data-session-ended={session.ended === false ? 'false' : 'true'}
      data-selection={session.selection ?? ''}
      className="grid h-dvh grid-cols-[16rem_minmax(0,1fr)] grid-rows-[auto_auto_minmax(0,1fr)_auto_auto] bg-background text-foreground"
      style={themeProperties(theme)}
    >
      <header className="col-span-2 flex flex-wrap items-center gap-3 border-b px-4 py-2 text-xs" style={{ color: 'var(--text-muted)' }}>
        <span data-testid="project-name" className="font-semibold" style={{ color: 'var(--text)' }}>
          {project}
        </span>
        <span data-testid="session-id">{session.session_id}</span>
        <span data-testid="revision" className="tabular-nums">
          revision {view.revision}
        </span>
        <span data-testid="theme-id">{theme.id}</span>
        <span data-testid="tree-key" className="sr-only">
          {JSON.stringify(tree.regions)}
        </span>
        <span className="ml-auto flex gap-2">
          <Button
            type="button"
            size="sm"
            variant={theme.id === THEME_DEFAULT.id ? 'secondary' : 'outline'}
            data-testid="theme-default"
            onClick={() => setSession((current) => changeTheme(current, THEME_DEFAULT.id))}
          >
            Default
          </Button>
          <Button
            type="button"
            size="sm"
            variant={theme.id === THEME_DAYLIGHT.id ? 'secondary' : 'outline'}
            data-testid="theme-daylight"
            onClick={() => setSession((current) => changeTheme(current, THEME_DAYLIGHT.id))}
          >
            Daylight
          </Button>
          <Button
            type="button"
            size="sm"
            variant={fixture === 'omitted' ? 'secondary' : 'outline'}
            data-testid="fixture-omitted"
            onClick={() => setFixture('omitted')}
          >
            Omitted slice
          </Button>
          <Button
            type="button"
            size="sm"
            variant={fixture === 'recorded' ? 'secondary' : 'outline'}
            data-testid="fixture-recorded"
            onClick={() => setFixture('recorded')}
          >
            Recorded observations
          </Button>
        </span>
      </header>
      <section
        data-testid="region-cut-through"
        className="col-span-2 max-h-[42vh] overflow-auto border-b px-4 py-3"
        style={{ background: 'var(--surface-raised)', boxShadow: '0 1px 0 var(--border)' }}
      >
        <h2 className="mb-2 text-xs tracking-wide uppercase" style={{ color: 'var(--text-muted)' }}>
          Cut-through
        </h2>
        {tree.regions['cut-through'].length === 0 ? (
          <p data-testid="cut-through-empty" className="text-sm" style={{ color: 'var(--condition-empty)' }}>
            {EMPTY_TEXT['cut-through']}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {tree.regions['cut-through'].map((node) => (
              <Occupant
                key={node.component === 'approval.pending@1' && 'request_id' in node ? node.request_id : 'withheld'}
                node={node}
                view={view}
                session={session}
                theme={theme}
                onSelect={(label) => setSession((current) => selectAttachment(current, label))}
              />
            ))}
          </div>
        )}
      </section>
      <nav data-testid="region-nav" className="row-span-2 overflow-auto border-r px-3 py-3">
        <h2 className="mb-2 text-xs tracking-wide uppercase" style={{ color: 'var(--text-muted)' }}>
          Navigation
        </h2>
        <Occupant
          node={tree.regions.nav}
          view={view}
          session={session}
          theme={theme}
          onSelect={(label) => setSession((current) => selectAttachment(current, label))}
        />
      </nav>
      <main data-testid="region-main" className="flex min-h-0 flex-col px-4 py-3">
        <h2 className="mb-2 text-xs tracking-wide uppercase" style={{ color: 'var(--text-muted)' }}>
          Conversational surface
        </h2>
        <div className="min-h-0 flex-1">
          <Occupant
            node={tree.regions['main.primary']}
            view={view}
            session={session}
            theme={theme}
            onSelect={(label) => setSession((current) => selectAttachment(current, label))}
          />
        </div>
      </main>
      <section data-testid="region-bottom" className="border-t px-4 py-2">
        <Occupant
          node={tree.regions['main.bottom']}
          view={view}
          session={session}
          theme={theme}
          onSelect={(label) => setSession((current) => selectAttachment(current, label))}
        />
      </section>
      <footer data-testid="region-drawer" className="col-span-2 border-t px-4 py-2">
        <Occupant
          node={tree.regions['right.drawer']}
          view={view}
          session={session}
          theme={theme}
          onSelect={(label) => setSession((current) => selectAttachment(current, label))}
        />
      </footer>
    </div>
  );
}

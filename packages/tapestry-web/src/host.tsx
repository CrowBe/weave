import {
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
import { Condition } from './paint/mark';
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
      <span data-testid="drawer-collapsed" className="text-[12px] leading-4" style={{ color: 'var(--text-muted)' }}>
        collapsed
      </span>
    );
  }
  if (presentation.kind === 'empty') {
    return <Condition kind="empty" mark={theme.mark['condition-empty']} text={presentation.text} />;
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

function Segment({
  pressed,
  testId,
  onClick,
  children,
}: {
  readonly pressed: boolean;
  readonly testId: string;
  readonly onClick: () => void;
  readonly children: string;
}) {
  return (
    <Button type="button" variant="segment" size="segment" aria-pressed={pressed} data-testid={testId} onClick={onClick}>
      {children}
    </Button>
  );
}

const column = 'max-lg:order-3 lg:col-start-1 lg:row-start-2';

export function Host() {
  const [fixture, setFixture] = useState<FixtureId>('omitted');
  const [session, setSession] = useState(() => freshSession('session-field', THEME_DEFAULT.id));
  const view = FIXTURES[fixture];
  const theme = themeOf(session);
  const tree = resolveTree(view, session);
  const project = view.project_name.status === 'disclosed' ? view.project_name.name : 'Project withheld';
  const pending = tree.regions['cut-through'].length;
  const observationCount = view.observations.status === 'disclosed' ? view.observations.items.length : null;
  const select = (label: string) => setSession((current) => selectAttachment(current, label));

  return (
    <div
      data-testid="shell"
      data-theme={theme.id}
      data-density={theme.density.comfort}
      data-tree={JSON.stringify(tree)}
      data-session-ended={session.ended === false ? 'false' : 'true'}
      data-selection={session.selection ?? ''}
      className="grid h-dvh grid-rows-[auto_minmax(0,1fr)] bg-[var(--canvas)] text-[var(--text)] lg:grid-cols-[14rem_minmax(0,1fr)_20rem] xl:grid-cols-[15rem_minmax(0,1fr)_24rem]"
      style={themeProperties(theme)}
    >
      <header className="col-span-full flex min-h-[var(--bar)] items-center gap-4 border-b border-[var(--hairline)] px-4 max-lg:order-1 xl:h-[var(--bar)]">
        <span className="flex min-w-0 flex-col justify-center leading-tight xl:flex-row xl:items-center xl:gap-4">
          <span data-testid="project-name" className="text-[15px] leading-5 font-semibold tracking-[-0.01em] whitespace-nowrap">
            {project}
          </span>
          <span className="flex gap-3 text-[11px] leading-4 xl:text-xs">
            <span className="shrink-0 whitespace-nowrap">
              <span style={{ color: 'var(--text-muted)' }}>session </span>
              <span data-testid="session-id" className="font-mono font-normal text-[var(--text)]">
                {session.session_id}
              </span>
            </span>
            <span data-testid="revision" className="shrink-0 whitespace-nowrap">
              <span className="font-sans" style={{ color: 'var(--text-muted)' }}>
                revision{' '}
              </span>
              <span className="font-mono font-normal text-[var(--text)] tabular-nums">{view.revision}</span>
            </span>
            <span className="shrink-0 whitespace-nowrap">
              <span style={{ color: 'var(--text-muted)' }}>theme </span>
              <span data-testid="theme-id" className="font-mono font-normal text-[var(--text)]">
                {theme.id}
              </span>
            </span>
          </span>
        </span>
        <span data-testid="tree-key" className="sr-only">
          {JSON.stringify(tree.regions)}
        </span>
        <span className="ml-auto flex items-center gap-3">
          <span className="flex min-h-7 items-center rounded-md border border-[var(--hairline)] bg-[var(--canvas)] p-[3px]" role="group" aria-label="Theme">
            <Segment pressed={theme.id === THEME_DEFAULT.id} testId="theme-default" onClick={() => setSession((current) => changeTheme(current, THEME_DEFAULT.id))}>
              Default
            </Segment>
            <Segment pressed={theme.id === THEME_DAYLIGHT.id} testId="theme-daylight" onClick={() => setSession((current) => changeTheme(current, THEME_DAYLIGHT.id))}>
              Daylight
            </Segment>
          </span>
          <span className="h-4 w-px bg-[var(--hairline)]" aria-hidden="true" />
          <span className="flex min-h-7 items-center gap-1.5 rounded-md border border-dashed border-[var(--hairline)] bg-[var(--canvas)] px-1.5 py-[3px]" role="group" aria-label="Fixture">
            <span className="text-[11px] leading-4" style={{ color: 'var(--text-muted)' }}>
              Fixture
            </span>
            <Segment pressed={fixture === 'omitted'} testId="fixture-omitted" onClick={() => setFixture('omitted')}>
              Omitted slice
            </Segment>
            <Segment pressed={fixture === 'recorded'} testId="fixture-recorded" onClick={() => setFixture('recorded')}>
              Recorded observations
            </Segment>
          </span>
        </span>
      </header>
      <nav data-testid="region-nav" className={`${column} min-h-0 overflow-auto`}>
        <div className="flex h-[var(--bar)] items-center border-b border-[var(--hairline)] px-[var(--pad)] text-[12px] leading-4 font-medium">
          Navigation
        </div>
        <div className="px-[var(--pad)] py-[var(--gap)]">
          <Occupant node={tree.regions.nav} view={view} session={session} theme={theme} onSelect={select} />
          <a
            href="#cut-through"
            className="mt-3 flex h-[var(--row)] items-center justify-between rounded-md px-2 text-[13px] leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
            style={{ color: 'var(--text-muted)' }}
          >
            <span>Pending authority requests</span>
            <span className="font-mono text-[11px] tabular-nums">{pending}</span>
          </a>
        </div>
      </nav>
      <div className="flex min-h-0 flex-col border-x border-[var(--hairline)] bg-[var(--surface)] max-lg:order-4 lg:col-start-2 lg:row-start-2">
        <div className="flex h-[var(--bar)] items-center justify-between border-b border-[var(--hairline)] px-[var(--pad)]">
          <h2 className="text-[12px] leading-4 font-medium">Conversational surface</h2>
          {observationCount === null ? null : (
            <span className="text-[12px] leading-4 tabular-nums" style={{ color: 'var(--text-muted)' }}>
              {observationCount} {observationCount === 1 ? 'observation' : 'observations'}
            </span>
          )}
        </div>
        <main data-testid="region-main" className="flex min-h-0 flex-1 flex-col">
          <Occupant node={tree.regions['main.primary']} view={view} session={session} theme={theme} onSelect={select} />
        </main>
        <section
          data-testid="region-bottom"
          className="flex h-[var(--bar)] items-center gap-3 border-t border-[var(--hairline)] px-[var(--pad)]"
        >
          <span className="text-[12px] leading-4 font-medium" style={{ color: 'var(--text-muted)' }}>
            Secondary strip
          </span>
          <Occupant node={tree.regions['main.bottom']} view={view} session={session} theme={theme} onSelect={select} />
        </section>
      </div>
      <aside className="flex min-h-0 flex-col max-lg:order-2 max-lg:max-h-[45vh] lg:col-start-3 lg:row-start-2">
        <section
          data-testid="region-drawer"
          className="flex h-[var(--bar)] shrink-0 items-center justify-between border-b border-[var(--hairline)] px-[var(--pad)]"
        >
          <span className="text-[12px] leading-4 font-medium">Drawer</span>
          <Occupant node={tree.regions['right.drawer']} view={view} session={session} theme={theme} onSelect={select} />
        </section>
        <section id="cut-through" data-testid="region-cut-through" className="flex min-h-0 flex-1 flex-col overflow-auto px-[var(--pad)] py-[var(--gap)]">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-[12px] leading-4 font-medium">Cut-through</h2>
            <span className="text-[12px] leading-4 tabular-nums" style={{ color: 'var(--text-muted)' }}>
              {pending} pending
            </span>
          </div>
          {tree.regions['cut-through'].length === 0 ? (
            <Condition kind="empty" mark={theme.mark['condition-empty']} text="No pending authority request" />
          ) : (
            <div className="flex flex-col gap-3">
              {tree.regions['cut-through'].map((node) => (
                <Occupant
                  key={node.component === 'approval.pending@1' && 'request_id' in node ? node.request_id : 'withheld'}
                  node={node}
                  view={view}
                  session={session}
                  theme={theme}
                  onSelect={select}
                />
              ))}
            </div>
          )}
        </section>
      </aside>
    </div>
  );
}

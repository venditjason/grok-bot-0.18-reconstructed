/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
import type * as ReactTypes from 'react';
import { contextMenuAnchor, type ContextMenuAnchor } from './context-menu-position';
import { AgentAvatar } from './agent-avatar';
import type { AgentProfile, TeamProfile } from './ui-state';
import { SidebarPointerDrag, type SidebarDragOptions } from './sidebar-pointer-drag';
const React: typeof ReactTypes = window.React;
type ProfileCardProps = SidebarDragOptions & { name: string; className: string; children: ReactTypes.ReactNode; onPress(): void; 'aria-label': string; 'aria-current'?: 'page'; title?: string; onContextMenu(event: ReactTypes.MouseEvent): void; onKeyDown(event: ReactTypes.KeyboardEvent): void };

export function SidebarProfileCard(props: ProfileCardProps) {
  const latest = React.useRef(props); latest.current = props;
  const controller = React.useRef<SidebarPointerDrag | undefined>(undefined);
  controller.current ??= new SidebarPointerDrag(() => latest.current);
  const drag = controller.current;
  React.useEffect(() => () => drag.destroy(), [drag]);
  return <button type="button" draggable={false} className={`${props.className} sidebar-profile-button ${props['aria-current'] ? 'text-glyph-vendit-heading bg-background-vendit-elevate' : 'text-glyph-gray-heading'}`} title={props.title ?? props.name} aria-label={props['aria-label']} aria-current={props['aria-current']} aria-description="카드를 드래그하여 같은 목록의 순서를 바꿀 수 있습니다. 우클릭 또는 Shift+F10으로 수정·복제·삭제와 앞뒤 이동 메뉴를 엽니다." aria-haspopup="menu"
    onPointerDown={event => drag.pointerDown(event, event.currentTarget)} onPointerMove={event => drag.pointerMove(event)} onPointerUp={event => drag.pointerUp(event)} onPointerCancel={event => drag.pointerCancel(event)} onLostPointerCapture={event => drag.lostPointerCapture(event)}
    onDragStart={event => event.preventDefault()} onClick={event => drag.click(event, () => latest.current.onPress())}
    onContextMenu={event => { drag.cancel(); props.onContextMenu(event); }} onKeyDown={event => { if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') drag.cancel(); props.onKeyDown(event); }}>{props.children}</button>;
}

export function AgentSidebarCards({ agents, teams = [], selectedId, avatarUrl, onOpen, onMenu, onReorder }: { agents: AgentProfile[]; teams?: TeamProfile[]; selectedId?: string; avatarUrl(id?: string): string | undefined; onOpen(id: string): void; onMenu?(id: string, anchor?: ContextMenuAnchor): void; onReorder?(id: string, target: string): void }) {
  const itemIds = agents.map(agent => agent.id);
  return <nav className="agent-sidebar-list agent-photo-grid" aria-label="에이전트 목록" data-sidebar-list="agent">{agents.length ? agents.map(agent => {
    const memberships = teams.filter(team => team.memberAgentIds.includes(agent.id));
    const showMenu = (event: ReactTypes.MouseEvent | ReactTypes.KeyboardEvent) => { if (!onMenu) return; event.preventDefault(); event.stopPropagation?.(); onMenu(agent.id, contextMenuAnchor(event)); };
    return <div className="agent-photo-entry" key={agent.id} data-sidebar-kind="agent" data-sidebar-id={agent.id}><SidebarProfileCard kind="agent" id={agent.id} name={agent.name} itemIds={itemIds} onMenu={onMenu ?? (() => {})} onReorder={onReorder} className="agent-photo-tile" aria-label={`${agent.name} 대화 열기, 소속 팀 ${memberships.length}개`} aria-current={agent.id === selectedId ? 'page' : undefined} title={agent.name} onPress={() => onOpen(agent.id)} onContextMenu={showMenu} onKeyDown={(event: ReactTypes.KeyboardEvent) => { if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') showMenu(event); }}><span className="agent-photo-card"><AgentAvatar name={agent.name} seed={agent.id} url={avatarUrl(agent.avatarId)} size="large" /><span className="agent-photo-name typo-l1/m text-glyph-gray-heading">{agent.name}</span><span className="agent-team-count typo-l2/r text-glyph-gray-caption" title={memberships.map(team => team.name).join(', ') || '소속 팀 없음'}>소속 팀 {memberships.length}개</span></span></SidebarProfileCard></div>;
  }) : <p className="sidebar-profile-empty typo-l1/r text-glyph-gray-caption">역할과 연결을 정해 첫 에이전트를 만드세요.</p>}</nav>;
}

export function TeamSidebarCards({ teams, agents, selectedId, avatarUrl, onOpen, onCreate, onMenu, onReorder }: { teams: TeamProfile[]; agents: AgentProfile[]; selectedId?: string; avatarUrl(id?: string): string | undefined; onOpen(id: string): void; onCreate(): void; onMenu?(id: string, anchor?: ContextMenuAnchor): void; onReorder?(id: string, target: string): void }) {
  const itemIds = teams.map(team => team.id);
  return <nav className="team-sidebar-list team-photo-list" aria-label="협업 팀 목록" data-sidebar-list="team">{teams.map(team => {
    const leaderId = team.leaderAgentId ?? team.memberAgentIds[0], leader = agents.find(agent => agent.id === leaderId);
    const members = team.memberAgentIds.filter(id => id !== leaderId).map(id => agents.find(agent => agent.id === id)).filter((agent): agent is AgentProfile => !!agent);
    return <div className="team-photo-entry" key={team.id} data-sidebar-kind="team" data-sidebar-id={team.id}><SidebarProfileCard kind="team" id={team.id} name={team.name} itemIds={itemIds} onMenu={onMenu ?? (() => {})} onReorder={onReorder} onContextMenu={(event: ReactTypes.MouseEvent) => { if (onMenu) { event.preventDefault(); event.stopPropagation?.(); onMenu(team.id, contextMenuAnchor(event)); } }} onKeyDown={(event: ReactTypes.KeyboardEvent) => { if (onMenu && ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu')) { event.preventDefault(); event.stopPropagation?.(); onMenu(team.id, contextMenuAnchor(event)); } }} className="team-photo-tile" aria-label={`${team.name} 대화 열기, 대표 ${leader?.name ?? '미지정'}, 팀원 ${members.length}명`} aria-current={team.id === selectedId ? 'page' : undefined} onPress={() => onOpen(team.id)}><span className="team-photo-card"><span className="team-photo-name typo-b3/sb text-glyph-gray-heading">{team.name}</span><span className="team-photo-people"><span className="team-leader-portrait" title={`대표 · ${leader?.name ?? '미지정'}`}><AgentAvatar name={leader?.name ?? '팀 대표'} seed={leaderId ?? team.id} url={avatarUrl(leader?.avatarId)} size="large" /><span className="team-leader-name typo-l2/m text-glyph-gray-description">{leader?.name ?? '대표 미지정'}</span></span>{members.length > 0 && <span className="team-member-portraits" aria-label="소속 팀원">{members.map(member => <span key={member.id} className="team-member-portrait" title={member.name} aria-label={`${member.name} 팀원`}><AgentAvatar name={member.name} seed={member.id} url={avatarUrl(member.avatarId)} size="small" /></span>)}</span>}</span></span></SidebarProfileCard></div>;
  })}</nav>;
}

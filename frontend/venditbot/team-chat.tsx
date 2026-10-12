import { AttachmentList } from './chat-attachments';
import type { ChatAttachment } from '../../source/shared/chat-attachments';
import { ChatComposer } from './chat-composer';
/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
import type * as ReactTypes from 'react';
import { Markdown } from './markdown-view';
import { TeamStatus } from './teams-ui';
import { shouldSendOnEnter, teamRunInProgress, teamContinuationId, type TeamProfile, type TeamRunSummary, type TeamRun, type Session } from './ui-state';
const React: typeof ReactTypes = window.React;
const { Button, TextArea } = window.VDS;

export function TeamConversationTurn({ run, detail, sessions, onDetails }: { run: TeamRunSummary; detail?: TeamRun; sessions: Session[]; onDetails(id: string): void }) {
  const finalSession = sessions.find(session => session.id === run.finalSessionId);
  const finalText = finalSession?.messages.findLast(message => message.role === 'assistant' && message.status === 'completed')?.text
    ?? detail?.messages.findLast(message => message.kind === 'result' && message.sessionId === run.finalSessionId)?.text;
  const working = teamRunInProgress(run), step = run.steps.find(item => item.status === 'running');
  const leader = run.members.find(member => member.id === run.leaderAgentId)?.name ?? run.steps.find(item => item.kind !== 'work')?.agentName ?? '팀 대표';
  const liveText = working && step && step.kind !== 'work' ? sessions.find(session => session.id === step.sessionId)?.messages.findLast(message => message.role === 'assistant')?.text : undefined;
  const extraMessages = detail?.messages.filter(message => message.kind === 'user').slice(1) ?? [];
  return <section className="team-conversation-turn" aria-label="팀 대표와의 대화">
    <article className="message user bg-background-base-subtle rounded-xl"><AttachmentList files={detail?.messages.find(message => message.kind === 'user')?.attachments}/><div className="message-text typo-b2/r text-glyph-gray-body">{run.goal}</div></article>
    {extraMessages.map(message => <article key={message.id} className="message user bg-background-base-subtle rounded-xl">{message.toAgentId && <div className="message-heading typo-l2/r text-glyph-gray-caption">→ {run.members.find(member => member.id === message.toAgentId)?.name ?? '팀 멤버'}</div>}<AttachmentList files={message.attachments}/><div className="message-text typo-b2/r text-glyph-gray-body">{message.text}</div></article>)}
    <article className="message assistant bg-background-base-normal rounded-xl"><div className="message-heading typo-b3/sb text-glyph-gray-heading">{leader}<span className="typo-l2/r text-glyph-gray-caption">팀 대표</span><TeamStatus status={run.status} /></div>
      {finalText ? <div className="message-text typo-b2/r text-glyph-gray-body"><Markdown text={finalText} /></div> : liveText ? <div className="message-text typo-b2/r text-glyph-gray-body"><Markdown text={liveText} /></div> : <p className="typo-b3/r text-glyph-gray-description" role={working ? 'status' : undefined}>{working ? step?.kind === 'work' ? `${step.agentName}에게 업무를 맡겼습니다. 결과를 모아 답변하겠습니다.` : '대표가 요청을 검토하고 있습니다…' : run.status === 'cancelled' ? '팀 작업을 중단했습니다.' : run.status === 'failed' ? '팀 작업을 완료하지 못했습니다.' : '최종 답변을 불러오고 있습니다.'}</p>}
      {run.error && <p className="message-error typo-b3/r text-glyph-danger-body" role="alert">{run.error}</p>}
      <div className="team-conversation-actions"><Button kind="common" hierarchy="ghost" size="xsmall" onPress={() => onDetails(run.id)}>진행 상황 · 멤버 대화</Button></div>
    </article>
  </section>;
}

export function TeamChat({ attachments = [], attachmentBusy, attachmentError, onChooseAttachments, onRemoveAttachment, focusRequest = 0, team, leaderName, history, details, sessions, prompt, busy, error, loading, onPrompt, onSend, onCancel, onDetails, onRetry }: { attachments?: ChatAttachment[]; attachmentBusy?: boolean; attachmentError?: string; onChooseAttachments?(): void; onRemoveAttachment?(id: string): void; focusRequest?: number; team?: TeamProfile; leaderName: string; history: TeamRunSummary[]; details: Record<string, TeamRun>; sessions: Session[]; prompt: string; busy?: boolean; error?: string; loading?: boolean; onPrompt(text: string): void; onSend(): void; onCancel(): void; onDetails(id: string): void; onRetry(): void }) {
  const current = history.at(-1), working = teamRunInProgress(current), continuation = teamContinuationId(history, current), scroll = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => { const node = scroll.current; if (node && node.scrollHeight - node.scrollTop - node.clientHeight < 240) node.scrollTop = node.scrollHeight; }, [sessions, details, current?.status]);
  React.useEffect(() => { const node = scroll.current; if (node) node.scrollTop = node.scrollHeight; }, [current?.id]);
  return <>
    <div className="view-body chat-scroll" ref={scroll}><div className="chat-width">
      {history.length ? <div className="messages">{history.map(run => <TeamConversationTurn key={run.id} run={run} detail={details[run.id]} sessions={sessions} onDetails={onDetails} />)}</div> : <div className="welcome"><div className="typo-l1/m text-glyph-vendit-heading">{team?.name ?? 'AI 팀'}</div><h2 className="typo-h1/b text-glyph-gray-heading">어떤 일을 맡길까요?</h2><p className="welcome-subtitle typo-b1/r text-glyph-gray-description">{leaderName || '팀 대표'}에게 바로 이야기하세요.<br />필요한 팀원과 협업하고 결과를 정리합니다.</p></div>}
      {error && <div className="team-detail-error" role="alert"><span className="typo-b3/r text-glyph-danger-body">{error}</span><Button kind="common" hierarchy="ghost" size="small" onPress={onRetry}>대화 다시 불러오기</Button></div>}
      {loading && !details[current?.id ?? ''] && <p className="typo-l1/r text-glyph-gray-caption" role="status">팀 대화를 불러오고 있습니다…</p>}
    </div></div>
    <footer className="composer-wrap"><div className="chat-width">
      {team ? <><ChatComposer label="팀 대표에게 메시지" placeholder={working ? '추가 지시나 참고할 내용을 알려주세요…' : `${leaderName || '팀 대표'}에게 할 일을 알려주세요…`} value={prompt} disabled={attachmentBusy} canSend={!!prompt.trim() || !!attachments.length} onChooseAttachments={onChooseAttachments} maxLength={8000} onChange={onPrompt} onSend={onSend} sending={busy} focusRequest={focusRequest} hint={working ? '추가 지시는 이후 대표·멤버 작업에 전달됩니다.' : 'Enter 입력 · Shift + Enter 줄바꿈 · 이미지·텍스트 첨부'}><AttachmentList files={attachments} onRemove={onRemoveAttachment}/>{attachmentError && <p className="attachment-error typo-l1/r text-glyph-danger-body" role="alert">{attachmentError}</p>}{attachmentBusy && <p role="status" className="typo-l1/r">첨부 파일 준비 중…</p>}</ChatComposer>{working && <div className="team-stop-action"><Button kind="destructive" hierarchy="ghost" size="xsmall" onPress={onCancel}>팀 작업 중단</Button></div>}<p className="footnote typo-l2/r text-glyph-gray-caption">대표와 팀원이 대화와 결과를 공유합니다. 멤버는 한 번에 한 명씩 작업합니다.</p></> : <p className="typo-b3/r text-glyph-gray-description">삭제된 팀의 대화입니다. 진행 기록을 확인하거나 내보낼 수 있습니다.</p>}
    </div></footer>
  </>;
}

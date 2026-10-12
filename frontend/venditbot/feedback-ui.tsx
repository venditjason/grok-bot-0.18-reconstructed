import type * as ReactTypes from 'react';
import type {FeedbackInput, FeedbackJob, FeedbackSnapshot} from '../../source/shared/feedback';
import {useLocalDraft} from './draft-storage';

const React: typeof ReactTypes = window.React;
const {Button, Dialog, TextInput, TextArea} = window.VDS;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statuses = {queued:'접수됨 · 실행 대기',running:'작업 중',validating:'검증 중',merged:'병합 확인됨',failed:'실패 · 확인 필요',blocked:'진행 조건 확인 필요',unknown:'실행 결과 확인 필요'} as const;
type Draft = {input: FeedbackInput; pending?: FeedbackInput; lastJobId?: string};
type Invoke = (method:string, args?:unknown) => Promise<unknown>;
export type FeedbackGuard = {dirty:boolean; pending:boolean};
export type FeedbackButtonProps = {invoke:Invoke; onOpenReportAgent(agentId?:string,sessionId?:string):void; onGuard?(guard:FeedbackGuard):void};
const object = (value:unknown):value is Record<string,unknown> => !!value && typeof value==='object' && !Array.isArray(value);
const text = (value:unknown,max:number):value is string => typeof value==='string' && value.length<=max && !value.includes('\0');
const inputValid = (value:unknown):value is FeedbackInput => object(value) && typeof value.requestId==='string' && uuid.test(value.requestId) && (value.kind==='bug'||value.kind==='request') && text(value.title,160) && text(value.description,12000);
const sameInput = (a:FeedbackInput,b:FeedbackInput) => a.requestId===b.requestId && a.kind===b.kind && a.title===b.title && a.description===b.description;
const blank = ():FeedbackInput => ({requestId:crypto.randomUUID(),kind:'bug',title:'',description:''});
export function feedbackDraft(value:unknown):Draft|undefined {
  if(!object(value)||!inputValid(value.input)||(value.pending!==undefined&&!inputValid(value.pending))||(value.lastJobId!==undefined&&(typeof value.lastJobId!=='string'||!uuid.test(value.lastJobId))))return;
  if(value.pending && !sameInput(value.input,value.pending as FeedbackInput))return;
  return {input:{...value.input},...(value.pending?{pending:{...value.pending as FeedbackInput}}:{}),...(value.lastJobId?{lastJobId:value.lastJobId as string}:{})};
}
export function feedbackReceipt(value:unknown):FeedbackJob|undefined {
  if(!object(value)||typeof value.id!=='string'||!uuid.test(value.id)||!inputValid({...value,requestId:value.id})||typeof value.status!=='string'||!Object.hasOwn(statuses,value.status)||!Number.isSafeInteger(value.revision)||Number(value.revision)<1||![value.createdAt,value.updatedAt].every(v=>typeof v==='string'&&Number.isFinite(Date.parse(v))))return;
  if(value.route!==undefined&&!['rabbit','local'].includes(String(value.route)))return;
  if(value.canResume!==undefined&&typeof value.canResume!=='boolean')return;
  for(const key of ['agentId','sessionId','message','prUrl','mergeSha'])if(value[key]!==undefined&&!text(value[key],4000))return;
  if(value.status==='merged' && (typeof value.mergeSha!=='string'||!/^[0-9a-f]{40}$/i.test(value.mergeSha)||typeof value.prUrl!=='string'||!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/.test(value.prUrl)))return;
  return value as unknown as FeedbackJob;
}
function snapshot(value:unknown):FeedbackSnapshot|undefined {
  if(!object(value)||typeof value.configured!=='boolean'||!Array.isArray(value.jobs)||value.jobs.length>1000||value.jobs.some(v=>!feedbackReceipt(v))||new Set(value.jobs.map(v=>v.id)).size!==value.jobs.length)return;
  if(value.agentId!==undefined&&!text(value.agentId,200))return;
  if(value.configurationMessage!==undefined&&!text(value.configurationMessage,4000))return;
  return value as unknown as FeedbackSnapshot;
}

export function FeedbackButton({invoke,onOpenReportAgent,onGuard}:FeedbackButtonProps) {
  const [initial] = React.useState<Draft>(()=>({input:blank()}));
  const [draft,setDraft,storage] = useLocalDraft('feedback',initial,feedbackDraft);
  const [open,setOpen] = React.useState(false), [state,setState] = React.useState<FeedbackSnapshot>(), [error,setError] = React.useState(''), [busy,setBusy] = React.useState('');
  const active = React.useRef(false), mounted = React.useRef(true), generation = React.useRef(0), current = React.useRef(draft);
  current.current=draft;
  const selected = state?.jobs.find(job=>job.id===draft.lastJobId);
  const put = (value:Draft) => {current.current=value;setDraft(value);};
  function acceptJob(job:FeedbackJob,input?:FeedbackInput) {
    if(input && (job.id!==input.requestId||job.kind!==input.kind||job.title!==input.title||job.description!==input.description))throw Error('receipt_mismatch');
    setState(previous=>{
      const prior=previous?.jobs.find(row=>row.id===job.id);
      return {...previous,configured:previous?.configured??false,jobs:[prior&&prior.revision>job.revision?prior:job,...(previous?.jobs??[]).filter(row=>row.id!==job.id)]};
    });
    if(input && current.current.pending && sameInput(current.current.pending,input))put({input:blank(),lastJobId:job.id});
  }
  async function load() {
    const at=++generation.current;
    try {
      const result=snapshot(await invoke('listFeedback'));if(!result)throw Error('invalid_snapshot');
      if(!mounted.current||at!==generation.current)return;
      setState(result);setError('');
      const pending=current.current.pending,match=pending&&result.jobs.find(job=>job.id===pending.requestId);
      if(match)acceptJob(match,pending);
    } catch {if(mounted.current&&at===generation.current)setError('접수 상태를 확인하지 못했습니다. 입력과 요청 번호는 보관하고 있습니다.');}
  }
  React.useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++;};},[]);
  React.useEffect(()=>{if(open)void load();},[open]);
  React.useEffect(()=>window.venditbot?.onEvent(event=>{if(event.type==='feedback'&&!active.current)void load();}),[]);
  React.useEffect(()=>{onGuard?.({dirty:!!draft.input.title||!!draft.input.description||!!storage.error,pending:!!busy||!!draft.pending});},[draft,busy,storage.error]);
  async function submit() {
    if(active.current)return;
    const input=current.current.pending??{...current.current.input,title:current.current.input.title.trim(),description:current.current.input.description.trim()};
    if(!input.title||!input.description||!inputValid(input))return;
    put({...current.current,input,pending:input});
    if(!storage.flush())return;
    active.current=true;generation.current++;setBusy('submit');setError('');
    try {
      const job=feedbackReceipt(await invoke('submitFeedback',input));if(!job)throw Error('invalid_receipt');
      if(mounted.current)acceptJob(job,input);
    } catch {if(mounted.current)setError('접수 응답을 확인하지 못했습니다. 아래 버튼으로 같은 요청 번호를 다시 확인하세요. 중복 작업을 새로 만들지 않습니다.');}
    finally {active.current=false;if(mounted.current)setBusy('');}
  }
  async function refresh() {
    if(active.current)return;
    if(!selected){await load();return;}
    active.current=true;generation.current++;setBusy('refresh');setError('');
    try {const job=feedbackReceipt(await invoke('refreshFeedback',{id:selected.id}));if(!job||job.id!==selected.id)throw Error('invalid_receipt');if(mounted.current)acceptJob(job);}
    catch {if(mounted.current)setError('최신 상태를 확인하지 못했습니다. 마지막으로 확인한 접수 내역을 유지합니다.');}
    finally {active.current=false;if(mounted.current)setBusy('');}
  }
  async function resume() {
    if(active.current||!selected?.canResume)return;
    const input:FeedbackInput={requestId:selected.id,kind:selected.kind,title:selected.title,description:selected.description};
    active.current=true;generation.current++;setBusy('resume');setError('');
    try {
      const job=feedbackReceipt(await invoke('submitFeedback',input));if(!job)throw Error('invalid_receipt');
      if(mounted.current)acceptJob(job,input);
    } catch {if(mounted.current)setError('실행 준비 결과를 확인하지 못했습니다. 상태 새로고침으로 기존 요청을 확인하세요. 새 요청을 만들지 않았습니다.');}
    finally {active.current=false;if(mounted.current)setBusy('');}
  }
  async function openAgent() {
    if(active.current)return;active.current=true;setBusy('agent');setError('');
    try {
      const result=await invoke('openFeedbackAgent');
      if(!object(result)||!text(result.agentId,200)||!result.agentId||!text(result.sessionId,200)||!result.sessionId)throw Error('invalid_agent');
      if(mounted.current){setOpen(false);onOpenReportAgent(result.agentId,result.sessionId);}
    } catch {if(mounted.current)setError('리포트 에이전트를 열지 못했습니다. 접수 상태를 확인하고 다시 시도하세요.');}
    finally {active.current=false;if(mounted.current)setBusy('');}
  }
  const locked=!!busy||!!draft.pending;
  const edit=(patch:Partial<FeedbackInput>)=>{if(!locked)put({...current.current,input:{...current.current.input,...patch}});};
  return <>
    <button type="button" className="feedback-button" aria-label="버그 신고 및 개선 요청" title="버그 신고 · 개선 요청" onClick={()=>setOpen(true)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m8 3 2 3m6-3-2 3M8 9V8a4 4 0 0 1 8 0v1M8 9h8v7a4 4 0 0 1-8 0V9Zm4 0v11M4 9l4 2m12-2-4 2M3 15h5m13 0h-5M5 21l4-3m10 3-4-3"/></svg></button>
    <Dialog.Root open={open} onOpenChange={setOpen}><Dialog.Portal managed={false}><Dialog.Content size="normal" className="feedback-dialog"><Dialog.Header title="버그 신고 · 개선 요청" description="불편한 점이나 만들고 싶은 기능을 리포트 에이전트에게 보내세요."/><div className="dialog-body feedback-body">
      <p className="typo-l1/r text-glyph-gray-description">보낸 요청은 이 Mac에 접수됩니다. 연결된 개발 경로에서 수정·검증을 진행하며, 병합은 검증 결과와 실행 권한이 확인된 경우에만 표시합니다. 비밀번호나 인증 키는 적지 마세요.</p>
      {state?.configured===false&&<p role="status" className="typo-l1/r text-glyph-warning-body">{state.configurationMessage||'개발 연결을 확인해야 합니다. 요청은 접수한 뒤 대기 상태로 보관됩니다.'}</p>}
      {storage.error&&<div role="alert"><p>{storage.error}</p>{storage.original&&!storage.original.preserved?<><details><summary>보관한 원본 초안</summary><pre className="draft-recovery-text">{storage.original.text}</pre></details><Button kind="common" hierarchy="secondary" size="small" onPress={()=>storage.preserveOriginal()}>원본 보관 후 계속</Button></>:<Button kind="common" hierarchy="secondary" size="small" onPress={()=>storage.flush()}>초안 저장 다시 시도</Button>}</div>}
      {error&&<p role="alert" className="error-copy typo-l1/r text-glyph-danger-body">{error}</p>}
      {selected&&<section className="feedback-status" aria-label="접수 상태"><p role="status" aria-live="polite" className="typo-b3/sb text-glyph-gray-heading">{statuses[selected.status]}</p><p className="typo-l1/r text-glyph-gray-body">{selected.title}</p>{selected.message&&<p className="typo-l1/r text-glyph-gray-description">{selected.message}</p>}<p className="typo-l2/r text-glyph-gray-caption">마지막 확인 {new Date(selected.updatedAt).toLocaleString('ko-KR')}</p><div className="feedback-actions">{selected.canResume&&<Button kind="vendit" hierarchy="secondary" size="small" disabled={!!busy} onPress={()=>void resume()}>실행 준비 다시 확인</Button>}<Button kind="common" hierarchy="ghost" size="small" disabled={!!busy} onPress={()=>void refresh()}>상태 새로고침</Button><Button kind="common" hierarchy="secondary" size="small" disabled={!!busy} onPress={()=>void openAgent()}>리포트 에이전트에서 보기</Button></div></section>}
      {draft.pending&&<p role="status" className="typo-l1/r text-glyph-warning-body">접수 여부를 확인 중입니다. 같은 요청 번호와 내용을 유지합니다.</p>}
      <label className="form-field typo-l1/m text-glyph-gray-description">요청 종류<select aria-label="리포트 요청 종류" className="select-control bg-background-base-normal text-glyph-gray-body border border-solid border-line-outline-stroke" value={draft.input.kind} disabled={locked} onChange={event=>edit({kind:event.target.value as FeedbackInput['kind']})}><option value="bug">버그 신고</option><option value="request">기능 · 개선 요청</option></select></label>
      <TextInput label="제목" aria-label="리포트 제목" maxLength={160} value={draft.input.title} disabled={locked} readOnly={locked} aria-disabled={locked} onChange={(event:ReactTypes.ChangeEvent<HTMLInputElement>)=>edit({title:event.target.value})}/>
      <label className="form-field typo-l1/m text-glyph-gray-description">내용<TextArea aria-label="리포트 내용" rows={6} maxLength={12000} placeholder="어느 화면에서 무엇을 했는지, 기대한 결과와 실제 결과를 알려 주세요." value={draft.input.description} disabled={locked} readOnly={locked} aria-disabled={locked} onChange={(event:ReactTypes.ChangeEvent<HTMLTextAreaElement>)=>edit({description:event.target.value})}/></label>
      <p className="typo-l2/r text-glyph-gray-caption">작성 중인 내용은 이 Mac에 보관합니다. 창을 닫아도 요청이나 실행 중인 작업은 취소되지 않습니다.</p>
    </div><Dialog.Footer RightComponent={()=><><Button kind="common" hierarchy="secondary" size="medium" onPress={()=>setOpen(false)}>닫기</Button><Button kind="vendit" size="medium" disabled={!!busy||!!storage.error||!draft.input.title.trim()||!draft.input.description.trim()} loading={busy==='submit'} onPress={()=>void submit()}>{draft.pending?'같은 요청 다시 확인':'리포트 보내기'}</Button></>}/></Dialog.Content></Dialog.Portal></Dialog.Root>
  </>;
}

/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
import type * as ReactTypes from 'react';
import type { Approval } from './ui-state';
const React: typeof ReactTypes = window.React;
const { Button, Dialog } = window.VDS;
const operationLabels = { write: '파일 쓰기', read: '파일 읽기', list: '파일 목록 조회', search: '내용 검색', manage: '설정 변경' };
export function ActionApproval({ approval, busy, error, onRespond }: { approval?: Approval; busy?: boolean; error?: string; onRespond(approved: boolean): void }) {
  return <Dialog.Root open={!!approval} onOpenChange={(open: boolean) => { if (!open) onRespond(false); }}><Dialog.Portal managed={false}><Dialog.Content size="normal" className="approval-dialog"><Dialog.Header hideCloseIcon title="이 작업을 허용할까요?" description="요청한 작업과 대상, 승인 이유를 확인하세요. 이번 요청에만 적용됩니다." /><div className="dialog-body">{approval && <><p className="typo-b3/sb text-glyph-gray-heading">{operationLabels[approval.operation]}{approval.tool ? ` · ${approval.tool}` : ''}</p><p className="typo-l1/r text-glyph-gray-description">대상</p><p className="typo-b3/sb text-glyph-gray-heading approval-path">{approval.path}</p>{approval.reason && <p className="typo-b3/r text-glyph-warning-body">승인 이유 · {approval.reason}</p>}{approval.operation === 'write' && approval.existing && <p className="typo-l1/r text-glyph-warning-body">기존 파일의 내용을 덮어씁니다.</p>}{approval.preview !== undefined && <pre className="approval-preview bg-background-base-subtle rounded-lg typo-c2/m text-glyph-gray-body">{approval.preview}</pre>}</>}{error && <p className="typo-b3/r text-glyph-danger-body" role="alert">{error}</p>}</div><Dialog.Footer RightComponent={() => <><Button kind="common" hierarchy="secondary" size="medium" disabled={busy} onPress={() => onRespond(false)}>거절</Button><Button kind="vendit" size="medium" disabled={busy} loading={!!busy} onPress={() => onRespond(true)}>이번 작업 허용</Button></>} /></Dialog.Content></Dialog.Portal></Dialog.Root>;
}

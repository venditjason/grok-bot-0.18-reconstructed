import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const built = await build({entryPoints:['source/venditbot/routine-intent.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {explicitRoutineMutation: has} = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
test('actual human instructions authorize only the requested routine action', () => {
  assert.equal(has('create_routine','매일 오전 9시에 메일 확인해서 보고해'),true);
  assert.equal(has('create_routine','루틴 등록해줘'),true);
  assert.equal(has('update_routine','보고서 루틴 시각 수정해줘'),true);
  assert.equal(has('delete_routine','보고서 루틴 삭제해줘'),true);
  assert.equal(has('set_routine_enabled','보고서 루틴 켜줘',true),true);
  assert.equal(has('set_routine_enabled','보고서 루틴 비활성화해줘',false),true);
  assert.equal(has('create_routine','Create a recurring report every day'),true);
  assert.equal(has('delete_routine','Remove this routine'),true);
});
test('listing, explanation, negation, different actions and ambiguity require approval', () => {
  for (const text of ['What happens if I create a daily routine?', 'The schedule was deleted yesterday', '어제 루틴 삭제했어요', 'show my routines','루틴 목록 보여줘','루틴 삭제하는 방법 알려줘','루틴 삭제하지 마','Do not delete this routine','루틴이 뭔지 설명해줘','오늘 보고서를 작성해줘']) {
    for (const name of ['create_routine','update_routine','delete_routine','set_routine_enabled']) assert.equal(has(name,text,true),false,`${name}: ${text}`);
  }
  assert.equal(has('create_routine','루틴 삭제해줘'),false);
  assert.equal(has('delete_routine','루틴 등록해줘'),false);
  assert.equal(has('set_routine_enabled','루틴 비활성화해줘',true),false);
  assert.equal(has('set_routine_enabled','루틴 켜줘',false),false);
});

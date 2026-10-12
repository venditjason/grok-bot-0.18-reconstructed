/** A conservative shortcut for explicit human scheduling instructions. Ambiguous
 * text always goes to the existing approval UI, never to model-supplied claims. */
export function explicitRoutineMutation(name: string, human: string, enabled?: unknown): boolean {
  if (typeof human !== 'string' || !human.trim()) return false;
  const text = human.normalize('NFKC').toLowerCase().trim();
  if (/\b(what|why|when|where|whether|if)\b|했(다|어|어요|는데)|되었|됐/.test(text)) return false;
  if (!/[가-힣]/.test(text) && !/^(?:(?:please|can you|could you|would you|i want you to)\s+)?(?:create|schedule|set up|register|update|change|edit|delete|remove|pause|disable|stop|enable|resume|turn on)\b/.test(text)) return false;
  if (/하지\s*(마|말)|말아|금지|않|don't|do not|never|방법|어떻게|how (to|do)|설명|explain|show|목록|알려|조회|확인만/.test(text)) return false;
  const routine = /루틴|반복|정기|예약|routine|schedule|recurring/.test(text);
  const recurring = /매일|매주|매월|매시간|\d+\s*(분|시간|일|주|개월)\s*마다|every\s+(day|week|month|hour|minute|\d+\s+(minutes?|hours?|days?))/.test(text);
  if (name === 'create_routine') return (routine || recurring) && !/삭제|제거|수정|변경|중지|비활성|delete|remove|update|change|disable|pause/.test(text) && (/등록|만들|생성|설정|예약해|create|schedule|set up|register/.test(text) || recurring && /해\s*줘|해\s*주세요|보고해|확인해|보내줘|check|report/.test(text));
  if (!routine) return false;
  if (name === 'update_routine') return /수정|변경|바꿔|바꾸|조정|update|change|edit/.test(text);
  if (name === 'delete_routine') return /삭제|제거|지워|지우|\b(delete|remove)\b/.test(text);
  if (name === 'set_routine_enabled') {
    const disable = /비활성|끄|꺼|중지|정지|pause|disable|stop/.test(text);
    return enabled === false ? disable : enabled === true && !disable && /활성|켜|다시\s*시작|재개|enable|resume|turn on/.test(text);
  }
  return false;
}

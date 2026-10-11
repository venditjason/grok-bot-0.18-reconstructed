export interface ProviderModel {
  id: string;
  /** Official aliases are retained for display; execution pins this resolved ID when supplied. */
  resolvedId?: string;
  label: string;
  description?: string;
  isDefault: boolean;
  efforts: string[];
  defaultEffort?: string;
}
export interface ProviderModelCatalog {
  models: ProviderModel[];
  fetchedAt: string;
  source: string;
  warning?: string;
}
export function selectProviderModel(catalog: ProviderModelCatalog, model?: string, effort?: string): { model: string; effort?: string } {
  const selected = model == null || model === "" ? catalog.models.find(item => item.isDefault)
    : catalog.models.find(item => item.id === model) ?? catalog.models.find(item => item.resolvedId === model);
  if (selected == null) throw new Error("선택한 모델을 공급자의 현재 목록에서 확인할 수 없습니다. 모델 목록을 새로고침한 뒤 다시 선택하세요.");
  const chosenEffort = effort == null || effort === "" ? selected.defaultEffort : effort;
  if (chosenEffort != null && !selected.efforts.includes(chosenEffort)) throw new Error("선택한 추론 수준은 이 모델이 지원하지 않습니다. 모델 목록에서 지원되는 수준을 선택하세요.");
  return { model: selected.resolvedId ?? selected.id, ...(chosenEffort ? { effort: chosenEffort } : {}) };
}

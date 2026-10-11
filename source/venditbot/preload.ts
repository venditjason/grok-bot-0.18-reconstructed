import { contextBridge, ipcRenderer } from 'electron';

const allowed = new Set(['state', 'authStatus', 'listModels', 'login', 'cancelLogin', 'disconnect', 'testAuth', 'saveProfile', 'deleteProfile', 'testApi', 'createSession', 'send', 'cancel', 'selectWorkspace', 'respondApproval', 'renameSession', 'deleteSession', 'exportSession', 'saveAgent', 'deleteAgent', 'cloneAgent', 'cloneTeam', 'savePolicy', 'deletePolicy', 'previewAgentPolicy', 'saveActionRules', 'saveRabbitConnection', 'deleteRabbitConnection', 'testRabbitConnection', 'startRabbitRun', 'retryRabbitRun', 'refreshRabbitRun', 'openRabbitProject', 'exportRabbitRun',
  'saveTeam', 'cancelAutomaticTeamCreation', 'deleteTeam', 'startTeamRun', 'getTeamRun', 'cancelTeamRun', 'postTeamMessage', 'deleteTeamRun', 'exportTeamRun',
  'generateAgentAvatar', 'cancelAgentAvatar', 'getAgentAvatar', 'checkUpdate', 'installUpdate']);
contextBridge.exposeInMainWorld('venditbot', Object.freeze({
  invoke: async (method: string, args?: unknown) => {
    if (!allowed.has(method)) throw new Error('지원하지 않는 작업입니다.');
    const response = await ipcRenderer.invoke('venditbot:request', { method, args });
    if (!response.ok) throw new Error(response.error);
    return response.value;
  },
  onEvent: (callback: (event: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => callback(payload);
    ipcRenderer.on('venditbot:event', listener);
    return () => ipcRenderer.removeListener('venditbot:event', listener);
  },
}));

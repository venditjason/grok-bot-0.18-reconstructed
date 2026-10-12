import {randomUUID} from 'node:crypto';
import type {RoutineTarget} from '../shared/routines.js';
import {connectionRoutes, type ChatSession, type LocalSessionStore} from './local-store.js';
import type {AgentStore} from './agent-store.js';
import {activeTeamRun, type TeamRunSummary, type TeamStore} from './team-store.js';
import type {TeamCoordinator} from './team-coordinator.js';
import type {RoutineOutcome, RoutineReservation} from './routine-store.js';
import type {RoutineSchedulerPort, RoutineDispatchStatus} from './routine-scheduler.js';

export interface RoutineHostPort {
  sessions: LocalSessionStore; agents: AgentStore; teams: TeamStore; coordinator: TeamCoordinator;
  queue(): {running: string[]; queued: string[]};
  unavailable(): boolean;
  enqueue(id: string, prompt: string, hooks: {started(): void; settled(session: ChatSession, error?: unknown): void}): unknown;
}

/** Correlation is committed in the conversation/run before it can enter a
 * provider queue. A crash with no definitive result remains unknown; it is
 * never interpreted as permission to repeat external work. */
export class RoutineHost implements RoutineSchedulerPort {
  private readonly waiting = new Map<string, (outcome: RoutineOutcome) => void>();
  constructor(private readonly port: RoutineHostPort) {}
  allocateDispatchId(): string {return randomUUID();}
  validateTarget(target: RoutineTarget): boolean {
    try {
      if (target.kind === 'agent') this.port.agents.get(target.id);
      else {const team = this.port.teams.getTeam(target.id); for (const id of team.memberAgentIds) this.port.agents.get(id);}
      return true;
    } catch {return false;}
  }
  isTargetBusy(target: RoutineTarget): boolean {
    if (this.port.unavailable()) return true;
    const queue = this.port.queue();
    if (queue.queued.length >= 16) return true;
    const ids = new Set([...queue.running, ...queue.queued]);
    const members = target.kind === 'team' ? [...new Set([...(this.port.teams.listTeams().find(t => t.id === target.id)?.memberAgentIds ?? []), ...this.port.teams.listActiveRuns().filter(r => r.teamId === target.id).flatMap(r => r.activeMemberAgentIds)])] : [target.id];
    return this.port.sessions.list().some(s => ids.has(s.id) && !!s.agentId && members.includes(s.agentId))
      || this.port.teams.listActiveRuns().some(r => target.kind === 'team' && r.teamId === target.id || r.activeMemberAgentIds.some(id => members.includes(id)));
  }
  inspectDispatch(id: string): RoutineDispatchStatus {
    if (this.waiting.has(id)) return 'running';
    const session = this.port.sessions.list().find(s => s.routineDispatchId === id);
    if (session) {
      if (session.taskStatus === 'completed') return 'completed';
      if (session.taskStatus === 'failed') return 'failed';
      const queue = this.port.queue();
      return queue.running.includes(session.id) || queue.queued.includes(session.id) ? 'running' : 'unknown';
    }
    const run = this.port.teams.listRuns().find(r => r.routineDispatchId === id);
    return run?.status === 'completed' ? 'completed' : run?.status === 'failed' ? 'failed' : 'unknown';
  }
  teamChanged(run: TeamRunSummary): void {
    if (!run.routineDispatchId || activeTeamRun(run)) return;
    const resolve = this.waiting.get(run.routineDispatchId);
    this.waiting.delete(run.routineDispatchId);
    resolve?.({status: run.status === 'completed' ? 'completed' : 'failed', ...(run.error ? {error: run.error} : {})});
  }
  async dispatchReserved(reservation: RoutineReservation): Promise<RoutineOutcome> {
    if (this.port.unavailable()) return {status: 'failed', error: '종료 또는 설정 변경 중이므로 예약 작업을 시작하지 않았습니다.'};
    if (!this.validateTarget(reservation.target)) return {status: 'failed', error: '예약 작업의 실행 대상이 없습니다.'};
    if (this.isTargetBusy(reservation.target)) return {status: 'failed', error: '같은 대상의 작업이 시작되어 이번 예약을 건너뛰었습니다.'};
    if (this.inspectDispatch(reservation.dispatchId) !== 'unknown'
      || this.port.sessions.list().some(s => s.routineDispatchId === reservation.dispatchId)
      || this.port.teams.listRuns().some(r => r.routineDispatchId === reservation.dispatchId)) throw new Error('이미 저장된 루틴 실행은 재전송하지 않습니다.');
    let resolve!: (outcome: RoutineOutcome) => void;
    const result = new Promise<RoutineOutcome>(done => {resolve = done;});
    this.waiting.set(reservation.dispatchId, resolve);
    try {
      if (reservation.target.kind === 'team') {
        const team = this.port.teams.getTeam(reservation.target.id);
        this.port.coordinator.start(team.id, reservation.prompt, team.memberAgentIds.map(id => this.port.agents.get(id)), undefined, {routineDispatchId: reservation.dispatchId});
      } else {
        const agent = this.port.agents.get(reservation.target.id), connections = connectionRoutes(agent), first = connections[0]!;
        const session = this.port.sessions.create(first.connectionId, first.model, agent.workspacePath, first.effort, {
          routineDispatchId: reservation.dispatchId, connections, agentId: agent.id, agentName: agent.name, instructions: agent.instructions,
          ...(agent.development ? {development: structuredClone(agent.development)} : {}),
          ...(agent.automation ? {automation: agent.automation, policyAllowedConnections: connections} : {}),
        });
        this.port.enqueue(session.id, reservation.prompt, {started() {}, settled: (settled, error) => {
          this.waiting.delete(reservation.dispatchId);
          resolve({status: !error && settled.taskStatus === 'completed' ? 'completed' : 'failed',
            ...(error ? {error: '작업 결과를 완료 상태로 저장하지 못했습니다.'} : settled.messages.at(-1)?.error ? {error: settled.messages.at(-1)!.error} : {})});
        }});
      }
      return await result;
    } catch (error) {
      this.waiting.delete(reservation.dispatchId);
      throw error;
    }
  }
}

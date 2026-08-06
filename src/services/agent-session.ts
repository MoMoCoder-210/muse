/**
 * Agent 会话持久化服务
 *
 * 通过后端 agent_sessions 表持久化会话（Phase 2 接入 SQLite）。
 * 当前 Phase 1 使用内存存储，重启后即丢失。
 */
import type { AgentSession, ChatMessage } from "../types/agent";

// Phase 1: 内存存储
const sessions = new Map<string, AgentSession>();

export function saveSession(session: AgentSession): void {
  sessions.set(session.id, session);
}

export function loadSession(sessionId: string): AgentSession | null {
  return sessions.get(sessionId) ?? null;
}

export function listSessions(projectId: string): AgentSession[] {
  return [...sessions.values()].filter((s) => s.projectId === projectId);
}

export function createSession(projectId: string, messages: ChatMessage[]): AgentSession {
  const session: AgentSession = {
    id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    projectId,
    messages,
    summary: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveSession(session);
  return session;
}

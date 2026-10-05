/*
 * 低延迟控制台核心：纯数据 + 事件日志，不依赖任何 UI 框架。
 *
 * 设计要点：
 * - 所有变更先入 journal 拿到全局连续 seq，再决定是否立刻 apply；
 * - 队列位置 / 剩余时间 / 字幕修订属于关键状态，任何模式都立即推送；
 * - 频道健康度、术语变更在低延迟模式只入日志（applied=false），退出或重启时按序重放；
 * - applyOperation 是纯 reducer，即时应用与崩溃重放走同一条路径，已 applied 的操作绝不执行第二遍；
 * - 译员归属在操作入队时快照进 payload，重放不再回查当前频道。
 */

export type SpeechStatus = 'queued' | 'speaking' | 'done' | 'skipped';
export type InterpreterStatus = 'active' | 'handoff' | 'standby';

export interface Room { id: string; name: string; topic: string; simultaneousChannels: number }
export interface Speech { id: string; roomId: string; speaker: string; delegation: string; language: string; topic: string; plannedSeconds: number; remainingSeconds: number; status: SpeechStatus; updatedAt: string }
export interface Channel { id: string; roomId: string; language: string; interpreter: string; status: InterpreterStatus; health: number; previousInterpreter: string | null; relievedSpeechId: string | null }
export interface Term { id: string; phrase: string; translation: string; language: string; approved: boolean }
export interface CaptionRevision { id: string; speechId: string; language: string; interpreter: string; captionist: string; text: string; revision: number; seq: number; at: string }
export interface Audit { id: string; seq: number; at: string; roomId: string; message: string }

export interface ConferenceState {
  rooms: Room[];
  activeRoomId: string;
  speechQueue: Speech[];
  channels: Channel[];
  terms: Term[];
  captionRevisions: CaptionRevision[];
  audits: Audit[];
}

export type OpPayload = {
  'room-switch': { roomId: string; roomName: string };
  'speech-add': { speech: Speech };
  'speech-advance': { speechId: string; status: SpeechStatus };
  'time-adjust': { speechId: string; deltaSeconds: number };
  'handoff-start': { channelId: string };
  'handoff-complete': { channelId: string; interpreter: string };
  'caption-submit': { speechId: string; language: string; interpreter: string; captionist: string; text: string; revisionId: string };
  'channel-health': { channelId: string; health: number };
  'term-approve': { termId: string };
};

export type OpDraft =
  | { type: 'room-switch'; at: string; payload: OpPayload['room-switch'] }
  | { type: 'speech-add'; at: string; payload: OpPayload['speech-add'] }
  | { type: 'speech-advance'; at: string; payload: OpPayload['speech-advance'] }
  | { type: 'time-adjust'; at: string; payload: OpPayload['time-adjust'] }
  | { type: 'handoff-start'; at: string; payload: OpPayload['handoff-start'] }
  | { type: 'handoff-complete'; at: string; payload: OpPayload['handoff-complete'] }
  | { type: 'caption-submit'; at: string; payload: OpPayload['caption-submit'] }
  | { type: 'channel-health'; at: string; payload: OpPayload['channel-health'] }
  | { type: 'term-approve'; at: string; payload: OpPayload['term-approve'] };
export type OpType = OpDraft['type'];

export type JournalOp = OpDraft & {
  id: string;
  seq: number;
  critical: boolean;
  applied: boolean;
};

export interface Journal {
  version: 2;
  lowLatency: boolean;
  nextSeq: number;
  ops: JournalOp[];
}

export const STORAGE_KEY = 'conference-interpretation-v2';
export const LEGACY_STORAGE_KEY = 'conference-interpretation-v1';
export const PRIMARY_LANGUAGE = '中文';
const LOW_LATENCY_BUFFERED_TYPES: ReadonlyArray<OpType> = ['channel-health', 'term-approve'];

export function isBufferedInLowLatency(type: OpType): boolean {
  return LOW_LATENCY_BUFFERED_TYPES.includes(type);
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export const now = () => new Date().toISOString();

export function makeSeedState(): ConferenceState {
  const seed: ConferenceState = {
    rooms: [
      { id: 'hall-a', name: 'A厅 · 全体会议', topic: '全球气候融资', simultaneousChannels: 6 },
      { id: 'hall-b', name: 'B厅 · 技术分会', topic: '人工智能基础设施', simultaneousChannels: 4 }
    ],
    activeRoomId: 'hall-a',
    speechQueue: [
      { id: 'speech-1', roomId: 'hall-a', speaker: 'Amina Diallo', delegation: '塞内加尔', language: '英语', topic: '适应性融资缺口', plannedSeconds: 600, remainingSeconds: 214, status: 'speaking', updatedAt: now() },
      { id: 'speech-2', roomId: 'hall-a', speaker: '李明远', delegation: '中国', language: '中文', topic: '绿色基础设施机制', plannedSeconds: 600, remainingSeconds: 600, status: 'queued', updatedAt: now() },
      { id: 'speech-3', roomId: 'hall-b', speaker: 'Maria Silva', delegation: '巴西', language: '葡萄牙语', topic: '边缘算力与能源', plannedSeconds: 420, remainingSeconds: 420, status: 'queued', updatedAt: now() }
    ],
    channels: [
      { id: 'ch-a-zh', roomId: 'hall-a', language: '中文', interpreter: '周雨', status: 'active', health: 96, previousInterpreter: null, relievedSpeechId: null },
      { id: 'ch-a-es', roomId: 'hall-a', language: '西班牙语', interpreter: 'Lucía M.', status: 'active', health: 91, previousInterpreter: null, relievedSpeechId: null },
      { id: 'ch-a-fr', roomId: 'hall-a', language: '法语', interpreter: 'Noah B.', status: 'standby', health: 88, previousInterpreter: null, relievedSpeechId: null },
      { id: 'ch-b-zh', roomId: 'hall-b', language: '中文', interpreter: '何佳', status: 'active', health: 94, previousInterpreter: null, relievedSpeechId: null }
    ],
    terms: [
      { id: 'term-1', phrase: 'loss and damage', translation: '损失与损害', language: '中文', approved: true },
      { id: 'term-2', phrase: 'edge inference', translation: '边缘推理', language: '中文', approved: true },
      { id: 'term-3', phrase: 'just transition', translation: '公正转型', language: '中文', approved: false }
    ],
    captionRevisions: [
      { id: 'caption-1', speechId: 'speech-1', language: '中文', interpreter: '周雨', captionist: '字幕员甲', text: '我们需要把适应资金与可衡量的社区韧性目标绑定。', revision: 2, seq: 0, at: now() }
    ],
    audits: [
      { id: 'audit-1', seq: 0, at: now(), roomId: 'hall-a', message: 'Amina Diallo 开始发言，中文频道由周雨接续' },
      { id: 'audit-2', seq: -1, at: new Date(Date.now() - 90000).toISOString(), roomId: 'hall-a', message: '临时插话申请已插入队列第2位' }
    ]
  };
  return seed;
}

export function makeSeedJournal(): Journal {
  return { version: 2, lowLatency: false, nextSeq: 1, ops: [] };
}

function pushAudit(state: ConferenceState, id: string, seq: number, at: string, roomId: string, message: string) {
  if (state.audits.some((audit) => audit.id === id)) return;
  state.audits.unshift({ id, seq, at, roomId, message });
}

/* 纯 reducer：同一条操作无论即时应用还是崩溃后重放，结果一致。 */
export function applyOperation(state: ConferenceState, op: JournalOp): void {
  switch (op.type) {
    case 'room-switch': {
      state.activeRoomId = op.payload.roomId;
      pushAudit(state, `audit-${op.id}`, op.seq, op.at, op.payload.roomId, `切换到 ${op.payload.roomName}`);
      break;
    }
    case 'speech-add': {
      if (state.speechQueue.some((item) => item.id === op.payload.speech.id)) break;
      state.speechQueue.push(clone(op.payload.speech));
      pushAudit(state, `audit-${op.id}`, op.seq, op.at, op.payload.speech.roomId, `${op.payload.speech.speaker} 已加入发言队列`);
      break;
    }
    case 'speech-advance': {
      const speech = state.speechQueue.find((item) => item.id === op.payload.speechId);
      if (!speech) break;
      speech.status = op.payload.status;
      speech.updatedAt = op.at;
      if (op.payload.status === 'speaking') {
        state.speechQueue.forEach((item) => {
          if (item.id !== speech.id && item.roomId === speech.roomId && item.status === 'speaking') item.status = 'done';
        });
        // 交接随发言生效：主持人切到下一位时，接班译员不跟过来，频道退回到接班前的译员。
        state.channels.forEach((channel) => {
          if (channel.roomId !== speech.roomId) return;
          if (channel.relievedSpeechId && channel.previousInterpreter !== null) {
            const relievedName = channel.interpreter;
            channel.interpreter = channel.previousInterpreter;
            channel.previousInterpreter = null;
            channel.relievedSpeechId = null;
            channel.status = 'active';
            pushAudit(state, `audit-${op.id}-rollback-${channel.id}`, op.seq, op.at, speech.roomId, `切换发言：${relievedName} 的接班仅服务上一位发言，${channel.language}频道已交还 ${channel.interpreter}`);
          } else if (channel.status === 'handoff') {
            channel.status = 'active';
          }
        });
      }
      pushAudit(state, `audit-${op.id}`, op.seq, op.at, speech.roomId, `发言 ${speech.speaker} 状态更新为 ${op.payload.status}`);
      break;
    }
    case 'time-adjust': {
      const speech = state.speechQueue.find((item) => item.id === op.payload.speechId);
      if (!speech) break;
      speech.remainingSeconds = Math.max(0, speech.remainingSeconds + op.payload.deltaSeconds);
      speech.updatedAt = op.at;
      break;
    }
    case 'handoff-start': {
      const channel = state.channels.find((item) => item.id === op.payload.channelId);
      if (!channel) break;
      channel.status = 'handoff';
      pushAudit(state, `audit-${op.id}`, op.seq, op.at, channel.roomId, `${channel.language}频道启动译员交接，原译文版本已冻结`);
      break;
    }
    case 'handoff-complete': {
      const channel = state.channels.find((item) => item.id === op.payload.channelId);
      const speech = state.speechQueue.find((item) => item.roomId === channel?.roomId && item.status === 'speaking');
      if (!channel) break;
      channel.previousInterpreter = channel.previousInterpreter ?? channel.interpreter;
      channel.relievedSpeechId = speech?.id ?? null;
      channel.interpreter = op.payload.interpreter;
      channel.status = 'active';
      channel.health = Math.min(100, channel.health + 2);
      pushAudit(state, `audit-${op.id}`, op.seq, op.at, channel.roomId, `${op.payload.interpreter} 接续 ${channel.language}频道（仅当前发言），后续字幕归属接班译员`);
      break;
    }
    case 'caption-submit': {
      if (state.captionRevisions.some((item) => item.id === op.payload.revisionId)) break;
      const speech = state.speechQueue.find((item) => item.id === op.payload.speechId);
      if (!speech) break;
      // 修订号取该段字幕现有最大修订号 + 1；串行入队保证两位字幕员按先后排队、互不覆盖。
      const revisionsForSpeech = state.captionRevisions.filter((item) => item.speechId === op.payload.speechId && item.language === op.payload.language);
      const revision = revisionsForSpeech.reduce((max, item) => Math.max(max, item.revision), 0) + 1;
      state.captionRevisions.unshift({
        id: op.payload.revisionId,
        speechId: op.payload.speechId,
        language: op.payload.language,
        interpreter: op.payload.interpreter,
        captionist: op.payload.captionist,
        text: op.payload.text,
        revision,
        seq: op.seq,
        at: op.at
      });
      break;
    }
    case 'channel-health': {
      const channel = state.channels.find((item) => item.id === op.payload.channelId);
      if (!channel) break;
      channel.health = Math.max(0, Math.min(100, op.payload.health));
      break;
    }
    case 'term-approve': {
      const term = state.terms.find((item) => item.id === op.payload.termId);
      if (!term) break;
      term.approved = true;
      pushAudit(state, `audit-${op.id}`, op.seq, op.at, state.activeRoomId, `术语已批准：${term.phrase}`);
      break;
    }
  }
}

/* 入队即分配全局连续 seq；低延迟下的非关键操作只入队不应用。 */
export function enqueueOperation(journal: Journal, state: ConferenceState, draft: OpDraft, options: { newId?: () => string; lowLatency?: boolean } = {}): JournalOp {
  const newId = options.newId ?? (() => crypto.randomUUID());
  const lowLatency = options.lowLatency ?? journal.lowLatency;
  const seq = journal.nextSeq;
  journal.nextSeq = seq + 1;
  const buffered = lowLatency && isBufferedInLowLatency(draft.type);
  const op: JournalOp = { ...draft, id: newId(), seq, critical: !isBufferedInLowLatency(draft.type), applied: !buffered };
  journal.ops.push(op);
  if (!buffered) applyOperation(state, op);
  return op;
}

/* 退出低延迟 / 崩溃重启：按 seq 重放所有未应用操作，已应用的绝不执行第二遍。返回重放条数。 */
export function flushJournal(journal: Journal, state: ConferenceState): number {
  const pending = journal.ops.filter((op) => !op.applied).sort((a, b) => a.seq - b.seq);
  for (const op of pending) {
    applyOperation(state, op);
    op.applied = true;
  }
  return pending.length;
}

/* 构造一条字幕提交操作：译员归属在提交瞬间解析并快照。 */
export function buildCaptionDraft(state: ConferenceState, speechId: string, captionist: string, text: string, options: { newId?: () => string } = {}): OpDraft | null {
  const newId = options.newId ?? (() => crypto.randomUUID());
  const speech = state.speechQueue.find((item) => item.id === speechId);
  const channel = state.channels.find((item) => item.roomId === speech?.roomId && item.language === PRIMARY_LANGUAGE);
  if (!speech || !channel || !text.trim()) return null;
  return {
    type: 'caption-submit',
    at: now(),
    payload: { speechId, language: channel.language, interpreter: channel.interpreter, captionist, text: text.trim(), revisionId: newId() }
  };
}

export function submitCaption(journal: Journal, state: ConferenceState, speechId: string, captionist: string, text: string, options: { newId?: () => string } = {}): JournalOp | null {
  const draft = buildCaptionDraft(state, speechId, captionist, text, options);
  if (!draft) return null;
  return enqueueOperation(journal, state, draft, options);
}

interface LegacyState extends ConferenceState {
  lowLatency?: boolean;
  captions?: Array<{ id: string; speechId: string; roomId: string; language: string; interpreter: string; text: string; revision: number; at: string }>;
}

function migrateLegacy(raw: string): { state: ConferenceState; journal: Journal } {
  const old = JSON.parse(raw) as LegacyState;
  const state: ConferenceState = {
    rooms: old.rooms,
    activeRoomId: old.activeRoomId,
    speechQueue: old.speechQueue,
    channels: old.channels.map((channel) => ({ ...channel, previousInterpreter: null, relievedSpeechId: null })),
    terms: old.terms,
    captionRevisions: (old.captions ?? []).map((caption) => ({ id: caption.id, speechId: caption.speechId, language: caption.language, interpreter: caption.interpreter, captionist: '字幕员甲', text: caption.text, revision: caption.revision, seq: 0, at: caption.at })),
    audits: old.audits.map((audit, index) => ({ ...audit, seq: -index }))
  };
  return { state, journal: { ...makeSeedJournal(), lowLatency: old.lowLatency ?? false } };
}

export function loadInitial(storage?: Pick<Storage, 'getItem' | 'removeItem'>): { state: ConferenceState; journal: Journal; recovered: number } {
  if (!storage) return { state: makeSeedState(), journal: makeSeedJournal(), recovered: 0 };
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { state: ConferenceState; journal: Journal };
      const recovered = flushJournal(parsed.journal, parsed.state);
      return { ...parsed, recovered };
    }
    const legacy = storage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) {
      const migrated = migrateLegacy(legacy);
      storage.removeItem(LEGACY_STORAGE_KEY);
      return { ...migrated, recovered: 0 };
    }
  } catch {
    // 日志损坏时回退种子数据，保证控制台可重启。
  }
  return { state: makeSeedState(), journal: makeSeedJournal(), recovered: 0 };
}

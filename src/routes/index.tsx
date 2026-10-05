import { $, component$, useSignal, useStore, useVisibleTask$ } from '@builder.io/qwik';
import { Progress } from '@qwik-ui/headless';
import { useForm, zodForm$ } from '@modular-forms/qwik';
import { useSpeakLocale } from 'qwik-speak';
import { z } from 'zod';
import type { DocumentHead } from '@builder.io/qwik-city';

type SpeechStatus = 'queued' | 'speaking' | 'done' | 'skipped';
type InterpreterStatus = 'active' | 'handoff' | 'standby';
type Room = { id: string; name: string; topic: string; simultaneousChannels: number };
type Speech = { id: string; roomId: string; speaker: string; delegation: string; language: string; topic: string; plannedSeconds: number; remainingSeconds: number; status: SpeechStatus; updatedAt: string };
type Channel = { id: string; roomId: string; language: string; interpreter: string; status: InterpreterStatus; health: number };
type Term = { id: string; phrase: string; translation: string; language: string; approved: boolean };
type Caption = { id: string; speechId: string; roomId: string; language: string; interpreter: string; text: string; revision: number; at: string };
type Audit = { id: string; at: string; roomId: string; message: string };

// 操作类型：关键状态立即生效，非关键状态（频道健康、术语变更）在低延迟时攒着不推
type OpType = 'caption' | 'speech-status' | 'handoff' | 'health' | 'term';
interface Op {
  id: string;        // 幂等键：算过的操作不再执行第二遍
  seq: number;       // 全局连续序号
  at: string;
  type: OpType;
  roomId: string;
  speechId?: string;
  channelId?: string;
  termId?: string;
  status?: SpeechStatus;
  interpreter?: string;
  delta?: number;
  approved?: boolean;
  text?: string;
  language?: string;
  revision?: number;
}

// 字幕修订提交：按提交先后排队（FIFO），不能互相覆盖
interface CaptionSubmission { id: string; speechId: string; text: string; at: string }

interface ConferenceState {
  rooms: Room[];
  activeRoomId: string;
  speechQueue: Speech[];
  channels: Channel[];
  terms: Term[];
  captions: Caption[];
  audits: Audit[];
  lowLatency: boolean;
  opLog: Op[];            // 已生效操作日志（追加写，用于崩溃恢复与幂等）
  pendingOps: Op[];       // 低延迟期间攒下的非关键更新，退出时按发生顺序重算
  lastSeq: number;        // 全局序号游标，保证序号连续
  captionQueue: CaptionSubmission[]; // 字幕修订提交队列
}

const now = new Date().toISOString();
const seed: ConferenceState = {
  rooms: [
    { id: 'hall-a', name: 'A厅 · 全体会议', topic: '全球气候融资', simultaneousChannels: 6 },
    { id: 'hall-b', name: 'B厅 · 技术分会', topic: '人工智能基础设施', simultaneousChannels: 4 }
  ],
  activeRoomId: 'hall-a',
  speechQueue: [
    { id: 'speech-1', roomId: 'hall-a', speaker: 'Amina Diallo', delegation: '塞内加尔', language: '英语', topic: '适应性融资缺口', plannedSeconds: 600, remainingSeconds: 214, status: 'speaking', updatedAt: now },
    { id: 'speech-2', roomId: 'hall-a', speaker: '李明远', delegation: '中国', language: '中文', topic: '绿色基础设施机制', plannedSeconds: 600, remainingSeconds: 600, status: 'queued', updatedAt: now },
    { id: 'speech-3', roomId: 'hall-b', speaker: 'Maria Silva', delegation: '巴西', language: '葡萄牙语', topic: '边缘算力与能源', plannedSeconds: 420, remainingSeconds: 420, status: 'queued', updatedAt: now }
  ],
  channels: [
    { id: 'ch-a-zh', roomId: 'hall-a', language: '中文', interpreter: '周雨', status: 'active', health: 96 },
    { id: 'ch-a-es', roomId: 'hall-a', language: '西班牙语', interpreter: 'Lucía M.', status: 'active', health: 91 },
    { id: 'ch-a-fr', roomId: 'hall-a', language: '法语', interpreter: 'Noah B.', status: 'standby', health: 88 },
    { id: 'ch-b-zh', roomId: 'hall-b', language: '中文', interpreter: '何佳', status: 'active', health: 94 }
  ],
  terms: [
    { id: 'term-1', phrase: 'loss and damage', translation: '损失与损害', language: '中文', approved: true },
    { id: 'term-2', phrase: 'edge inference', translation: '边缘推理', language: '中文', approved: true },
    { id: 'term-3', phrase: 'just transition', translation: '公正转型', language: '中文', approved: false }
  ],
  captions: [
    { id: 'caption-1', speechId: 'speech-1', roomId: 'hall-a', language: '中文', interpreter: '周雨', text: '我们需要把适应资金与可衡量的社区韧性目标绑定。', revision: 2, at: now }
  ],
  audits: [
    { id: 'audit-1', at: now, roomId: 'hall-a', message: 'Amina Diallo 开始发言，中文频道由周雨接续' },
    { id: 'audit-2', at: new Date(Date.now() - 90000).toISOString(), roomId: 'hall-a', message: '临时插话申请已插入队列第2位' }
  ],
  lowLatency: false,
  opLog: [],
  pendingOps: [],
  lastSeq: 0,
  captionQueue: []
};

const captionSchema = z.object({ text: z.string().min(1, '字幕不能为空') });
const queueSchema = z.object({
  speaker: z.string().min(2, '请输入发言人'),
  delegation: z.string().min(2, '请输入代表团'),
  language: z.string().min(2),
  topic: z.string().min(3, '请输入议题'),
  plannedSeconds: z.coerce.number().min(60).max(3600)
});
type QueueForm = z.infer<typeof queueSchema>;

const STORAGE_KEY = 'conference-interpretation-v1';

function readState(): ConferenceState {
  if (typeof localStorage === 'undefined') return seed;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return seed;
    const parsed = JSON.parse(raw) as Partial<ConferenceState> | null;
    if (!parsed) return seed;
    // 合并默认字段，保证旧存档也能补齐日志/队列等结构
    return {
      ...seed,
      ...parsed,
      opLog: parsed.opLog ?? [],
      pendingOps: parsed.pendingOps ?? [],
      lastSeq: parsed.lastSeq ?? 0,
      captionQueue: parsed.captionQueue ?? []
    };
  } catch {
    return seed;
  }
}

function addAudit(state: ConferenceState, message: string) {
  state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId: state.activeRoomId, message });
}

// 生成操作：分配全局连续序号
function makeOp(state: ConferenceState, type: OpType, extra: Partial<Op> = {}): Op {
  const seq = ++state.lastSeq;
  return { id: crypto.randomUUID(), seq, at: new Date().toISOString(), type, roomId: state.activeRoomId, ...extra };
}

// 应用操作（幂等）：已在日志中的操作不再执行第二遍
function applyOp(state: ConferenceState, op: Op) {
  if (state.opLog.some((o) => o.id === op.id)) return;
  switch (op.type) {
    case 'caption': {
      const speechId = op.speechId!;
      const language = op.language ?? '中文';
      const text = op.text ?? '';
      const interpreter = op.interpreter ?? '待分配';
      const thread = state.captions.find((c) => c.speechId === speechId && c.language === language);
      // 修订号连续：在该字幕线程当前修订号上 +1
      const revision = (thread?.revision ?? 0) + 1;
      if (thread) {
        state.captions = state.captions.map((c) => c.id === thread.id ? { ...c, text, interpreter, revision, at: op.at } : c);
      } else {
        state.captions.unshift({ id: crypto.randomUUID(), speechId, roomId: op.roomId, language, interpreter, text, revision, at: op.at });
      }
      op.revision = revision;
      break;
    }
    case 'speech-status': {
      state.speechQueue = state.speechQueue.map((s) => s.id === op.speechId ? { ...s, status: op.status!, updatedAt: op.at } : s);
      if (op.status === 'speaking') {
        state.speechQueue = state.speechQueue.map((s) => s.id !== op.speechId && s.roomId === op.roomId && s.status === 'speaking' ? { ...s, status: 'done' } : s);
      }
      break;
    }
    case 'handoff': {
      state.channels = state.channels.map((c) => c.id === op.channelId ? { ...c, interpreter: op.interpreter!, status: 'active' } : c);
      break;
    }
    case 'health': {
      state.channels = state.channels.map((c) => c.id === op.channelId ? { ...c, health: Math.max(0, Math.min(100, c.health + (op.delta ?? 0))) } : c);
      break;
    }
    case 'term': {
      state.terms = state.terms.map((t) => t.id === op.termId ? { ...t, approved: !!op.approved } : t);
      break;
    }
  }
  state.opLog.push(op);
  state.lastSeq = Math.max(state.lastSeq, op.seq);
}

// 非关键更新：低延迟时攒着不推，退出低延迟后再重算
function bufferOrApply(state: ConferenceState, op: Op) {
  if (state.lowLatency) state.pendingOps.push(op);
  else applyOp(state, op);
}

// 按发生顺序重算攒下的更新；幂等保证崩溃恢复时不会重复执行
function drainPending(state: ConferenceState) {
  while (state.pendingOps.length > 0) {
    const op = state.pendingOps[0];
    applyOp(state, op);
    state.pendingOps.shift();
  }
}

// 崩溃恢复：重启后重算序号与攒下的更新，序号/修订号保持连续
function reconcileState(state: ConferenceState) {
  const maxLogged = state.opLog.reduce((m, o) => Math.max(m, o.seq), 0);
  const maxPending = state.pendingOps.reduce((m, o) => Math.max(m, o.seq), 0);
  state.lastSeq = Math.max(state.lastSeq ?? 0, maxLogged, maxPending);
  if (state.pendingOps.length > 0) drainPending(state);
}

// 字幕归属：只挂到当前真正在岗的译员名下；交接班/占位译员期间不挂名，避免误绑定
function captionInterpreterFor(state: ConferenceState, speechId: string): string {
  const speech = state.speechQueue.find((s) => s.id === speechId);
  if (!speech) return '待分配';
  const channel = state.channels.find((c) => c.roomId === speech.roomId && c.language === '中文');
  if (!channel) return '待分配';
  if (channel.status === 'handoff' || channel.interpreter.startsWith('替补译员')) return '待分配';
  return channel.interpreter;
}

// 处理字幕修订队列：FIFO 依次提交，修订号连续，不互相覆盖
function processCaptionQueue(state: ConferenceState) {
  while (state.captionQueue.length > 0) {
    const submission = state.captionQueue.shift()!;
    const speech = state.speechQueue.find((s) => s.id === submission.speechId);
    if (!speech) continue;
    const interpreter = captionInterpreterFor(state, speech.id);
    const op = makeOp(state, 'caption', { speechId: speech.id, roomId: speech.roomId, language: '中文', text: submission.text, interpreter });
    applyOp(state, op); // 字幕修订号是大屏关键状态，立即生效，不攒
  }
}

export default component$(() => {
  const locale = useSpeakLocale();
  const state = useStore<ConferenceState>(readState());
  const captionLoader = useSignal({ text: '' });
  const [captionForm, { Form: CaptionForm, Field: CaptionField }] = useForm<z.infer<typeof captionSchema>>({
    loader: captionLoader,
    validate: zodForm$(captionSchema)
  });
  const queueLoader = useSignal<QueueForm>({ speaker: '', delegation: '', language: '英语', topic: '', plannedSeconds: 300 });
  const [queueForm, { Form: QueueForm, Field: QueueField }] = useForm<QueueForm>({
    loader: queueLoader,
    validate: zodForm$(queueSchema)
  });

  // 崩溃恢复：控制台重启后重算中断前攒下的更新，保持序号/修订号连续
  useVisibleTask$(() => { reconcileState(state); });

  // 持久化：每次变更写入 localStorage，刷新后继续保留
  useVisibleTask$(({ track }) => {
    track(() => state);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  });

  const activeRoom = () => state.rooms.find((room) => room.id === state.activeRoomId) ?? state.rooms[0];
  const roomQueue = () => state.speechQueue.filter((item) => item.roomId === state.activeRoomId);
  const roomChannels = () => state.channels.filter((item) => item.roomId === state.activeRoomId);
  const currentSpeech = () => roomQueue().find((item) => item.status === 'speaking');
  const currentPosition = () => {
    const idx = roomQueue().findIndex((item) => item.status === 'speaking');
    return idx === -1 ? 0 : idx + 1;
  };
  const currentRevision = () => state.captions.find((c) => c.speechId === currentSpeech()?.id && c.language === '中文')?.revision ?? 0;
  const formatRemaining = (seconds: number) => {
    const s = Math.max(0, seconds);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };

  const selectRoom$ = $((roomId: string) => {
    state.activeRoomId = roomId;
    addAudit(state, `切换到 ${state.rooms.find((room) => room.id === roomId)?.name}`);
  });

  const addSpeech$ = $((values: QueueForm) => {
    state.speechQueue.push({ id: crypto.randomUUID(), roomId: state.activeRoomId, ...values, remainingSeconds: values.plannedSeconds, status: 'queued', updatedAt: new Date().toISOString() });
    addAudit(state, `${values.speaker} 已加入发言队列`);
  });

  const advanceSpeech$ = $((id: string, status: SpeechStatus) => {
    const op = makeOp(state, 'speech-status', { speechId: id, status });
    applyOp(state, op);
    addAudit(state, `发言 ${id} 状态更新为 ${status}`);
  });

  const handoff$ = $((channelId: string) => {
    state.channels = state.channels.map((channel) => channel.id === channelId ? { ...channel, status: 'handoff' } : channel);
    addAudit(state, `${channelId} 启动译员交接，原译文版本已冻结`);
  });

  const completeHandoff$ = $((channelId: string, interpreter: string) => {
    const handoffOp = makeOp(state, 'handoff', { channelId, interpreter });
    applyOp(state, handoffOp);
    // 频道健康度是非关键状态：低延迟时攒着不推，退出后再重算
    const healthOp = makeOp(state, 'health', { channelId, delta: 2 });
    bufferOrApply(state, healthOp);
    addAudit(state, `${interpreter} 接续 ${channelId}，后续字幕归属新译员`);
  });

  const publishCaption$ = $((values: z.infer<typeof captionSchema>) => {
    const speech = state.speechQueue.find((item) => item.roomId === state.activeRoomId && item.status === 'speaking');
    if (!speech || !values.text.trim()) return;
    // 按提交先后入队，FIFO 处理，修订号连续不覆盖
    state.captionQueue.push({ id: crypto.randomUUID(), speechId: speech.id, text: values.text.trim(), at: new Date().toISOString() });
    processCaptionQueue(state);
  });

  const approveTerm$ = $((id: string) => {
    // 术语变更是非关键状态：低延迟时攒着不推，退出后再重算
    const op = makeOp(state, 'term', { termId: id, approved: true });
    bufferOrApply(state, op);
    addAudit(state, `术语已批准：${state.terms.find((term) => term.id === id)?.phrase}`);
  });

  const toggleLowLatency$ = $(() => {
    state.lowLatency = !state.lowLatency;
    // 退出低延迟：把攒下的更新按发生顺序重算回去
    if (!state.lowLatency) drainPending(state);
  });

  return (
    <main class={`conference-shell ${state.lowLatency ? 'low-latency' : ''}`}>
      <header class="hero">
        <div><span class="pill">{locale.lang}</span><h1>同声传译与发言队列</h1><p>{activeRoom().name} · {activeRoom().topic}</p></div>
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <select value={state.activeRoomId} onChange$={(event) => selectRoom$((event.target as HTMLSelectElement).value)}>{state.rooms.map((room) => <option value={room.id}>{room.name}</option>)}</select>
          <button class="secondary" onClick$={toggleLowLatency$}>{state.lowLatency ? '退出低延迟' : '低延迟模式'}</button>
        </div>
      </header>

      {state.lowLatency && (
        <section class="panel big-screen" aria-label="低延迟大屏">
          <div class="big-screen-grid">
            <div class="big-stat"><span class="big-label">发言队列当前位置</span><span class="big-value">#{currentPosition()}</span></div>
            <div class="big-stat"><span class="big-label">当前发言剩余时间</span><span class="big-value">{formatRemaining(currentSpeech()?.remainingSeconds ?? 0)}</span></div>
            <div class="big-stat"><span class="big-label">字幕修订号</span><span class="big-value">v{currentRevision()}</span></div>
          </div>
          <p class="big-hint">低延迟模式：大屏仅跟随队列位置、剩余时间与字幕修订号；频道健康度与术语变更已攒着不推。</p>
        </section>
      )}

      <section class="grid">
        <article class="panel">
          <div style="display:flex;justify-content:space-between;align-items:center"><h2>发言队列</h2><span class="pill">{roomQueue().length} 条 · {activeRoom().simultaneousChannels} 个同传频道</span></div>
          {roomQueue().map((speech, index) => (
            <div class={`queue-row ${speech.status === 'speaking' ? 'active' : ''}`} key={speech.id}>
              <strong>#{index + 1}</strong>
              <div><b>{speech.speaker}</b><div style="color:#638087;font-size:13px">{speech.delegation} · {speech.language} · {speech.topic}</div></div>
              <span class="pill">{speech.status}</span>
              <div style="display:flex;gap:6px">
                {speech.status === 'queued' && <button onClick$={() => advanceSpeech$(speech.id, 'speaking')}>开始</button>}
                {speech.status === 'speaking' && <><button onClick$={() => advanceSpeech$(speech.id, 'done')}>结束</button><button class="secondary" onClick$={() => speech.remainingSeconds = Math.max(0, speech.remainingSeconds - 60)}>减1分钟</button></>}
                {speech.status === 'queued' && <button class="danger" onClick$={() => advanceSpeech$(speech.id, 'skipped')}>跳过</button>}
              </div>
            </div>
          ))}
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:18px">
            <QueueForm onSubmit$={addSpeech$}>
              <QueueField name="speaker">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="发言人" />}</QueueField>
              <QueueField name="delegation">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="代表团" />}</QueueField>
              <QueueField name="topic">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="议题" />}</QueueField>
              <QueueField name="plannedSeconds" type="number">{(field, props) => <input {...props} type="number" value={field.value} onInput$={(event) => field.value = Number((event.target as HTMLInputElement).value)} placeholder="计划秒数" />}</QueueField>
              <button type="submit">加入队列</button>
            </QueueForm>
          </div>
        </article>

        <aside class="panel">
          <h2>频道与译员</h2>
          {roomChannels().map((channel) => (
            <div style="padding:12px 0;border-bottom:1px solid #e6efee" key={channel.id}>
              <div style="display:flex;justify-content:space-between"><b>{channel.language} · {channel.interpreter}</b><span class="pill">{channel.status}</span></div>
              <div class="decorative" style="margin:8px 0"><Progress.Root value={channel.health} max={100} /></div>
              <div style="display:flex;gap:8px"><button class="secondary" onClick$={() => handoff$(channel.id)}>开始交接</button>{channel.status === 'handoff' && <button onClick$={() => completeHandoff$(channel.id, `替补译员-${channel.language}`)}>完成交接</button>}</div>
            </div>
          ))}
          <h3>实时字幕修正</h3>
          {currentSpeech() ? <CaptionForm onSubmit$={publishCaption$}><CaptionField name="text">{(field, props) => <textarea {...props} rows={3} value={field.value} onInput$={(event) => field.value = (event.target as HTMLTextAreaElement).value} placeholder="输入或修正当前字幕" />}</CaptionField><button type="submit">提交新版字幕</button></CaptionForm> : <p>当前没有发言中的代表。</p>}
          {state.captions.filter((caption) => caption.roomId === state.activeRoomId).map((caption) => <div style="margin-top:10px;padding:10px;background:#f1f8f7;border-radius:10px" key={caption.id}><b>{caption.interpreter} · v{caption.revision}</b><p>{caption.text}</p></div>)}
        </aside>
      </section>

      <section class="grid" style="margin-top:18px">
        <article class="panel non-essential">
          <h2>术语库</h2>
          {state.terms.map((term) => <div class="queue-row" key={term.id}><span/><div><b>{term.phrase}</b><div>{term.translation} · {term.language}</div></div><span class="pill">{term.approved ? '已批准' : '待审'}</span><button disabled={term.approved} onClick$={() => approveTerm$(term.id)}>批准</button></div>)}
        </article>
        <article class="panel non-essential">
          <h2>操作与交接时间线</h2>
          {state.audits.filter((audit) => audit.roomId === state.activeRoomId).slice(0, 10).map((audit) => <div style="padding:10px 0;border-bottom:1px solid #e6efee" key={audit.id}><small>{new Date(audit.at).toLocaleTimeString()}</small><div>{audit.message}</div></div>)}
        </article>
      </section>
    </main>
  );
});

export const head: DocumentHead = {
  title: '国际会议同声传译控制台',
  meta: [{ name: 'description', content: '发言队列、多语种频道、术语、译员交接与实时字幕修正原型' }]
};

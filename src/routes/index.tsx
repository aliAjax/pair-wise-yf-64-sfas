import { $, component$, useSignal, useStore, useVisibleTask$ } from '@builder.io/qwik';
import { Progress } from '@qwik-ui/headless';
import { reset, useForm, zodForm$ } from '@modular-forms/qwik';
import { useSpeakLocale } from 'qwik-speak';
import { z } from 'zod';
import type { DocumentHead } from '@builder.io/qwik-city';
import {
  buildCaptionDraft,
  enqueueOperation,
  flushJournal,
  loadInitial,
  makeSeedJournal,
  makeSeedState,
  now,
  PRIMARY_LANGUAGE,
  STORAGE_KEY,
  type ConferenceState,
  type Journal,
  type OpDraft,
  type SpeechStatus
} from '~/lib/conference';

const captionSchema = z.object({ text: z.string().min(1, '字幕不能为空') });
const queueSchema = z.object({
  speaker: z.string().min(2, '请输入发言人'),
  delegation: z.string().min(2, '请输入代表团'),
  language: z.string().min(2),
  topic: z.string().min(3, '请输入议题'),
  plannedSeconds: z.coerce.number().min(60).max(3600)
});
type QueueForm = z.infer<typeof queueSchema>;

export default component$(() => {
  const locale = useSpeakLocale();
  // SSR/首屏先给种子数据，客户端 useVisibleTask 再从 localStorage 恢复（含攒批重放）。
  const initial = typeof window === 'undefined'
    ? { state: makeSeedState(), journal: makeSeedJournal(), recovered: 0 }
    : loadInitial(window.localStorage);
  const state = useStore<ConferenceState>(initial.state, { deep: true });
  const journal = useStore<Journal>(initial.journal, { deep: true });
  const recoveredCount = useSignal(initial.recovered);
  const captionLoader = useSignal({ text: '' });
  const captionist = useSignal('字幕员甲');
  const [captionForm, { Form: CaptionForm, Field: CaptionField }] = useForm<z.infer<typeof captionSchema>>({
    loader: captionLoader,
    validate: zodForm$(captionSchema)
  });
  const queueLoader = useSignal<QueueForm>({ speaker: '', delegation: '', language: '英语', topic: '', plannedSeconds: 300 });
  const [queueForm, { Form: QueueForm, Field: QueueField }] = useForm<QueueForm>({
    loader: queueLoader,
    validate: zodForm$(queueSchema)
  });

  useVisibleTask$(({ track }) => {
    // 崩溃恢复：重放日志中所有未应用的攒批操作，恢复到中断前的完整状态。
    const restored = loadInitial(window.localStorage);
    if (restored.journal.ops.length > 0 || restored.recovered > 0) {
      Object.assign(state, restored.state);
      Object.assign(journal, restored.journal);
      recoveredCount.value = restored.recovered;
    }
  });

  useVisibleTask$(({ track }) => {
    track(journal);
    track(state);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ state, journal }));
  });

  const activeRoom = () => state.rooms.find((room) => room.id === state.activeRoomId) ?? state.rooms[0];
  const roomQueue = () => state.speechQueue.filter((item) => item.roomId === state.activeRoomId);
  const roomChannels = () => state.channels.filter((item) => item.roomId === state.activeRoomId);
  const currentSpeech = () => roomQueue().find((item) => item.status === 'speaking');
  const currentIndex = () => {
    const queue = roomQueue();
    const speaking = queue.findIndex((item) => item.status === 'speaking');
    return speaking >= 0 ? speaking + 1 : 0;
  };
  const pendingOps = () => journal.ops.filter((op) => !op.applied);
  const pendingHealth = () => pendingOps().filter((op) => op.type === 'channel-health').length;
  const pendingTerms = () => pendingOps().filter((op) => op.type === 'term-approve').length;
  const currentRevision = () => {
    const speech = currentSpeech();
    if (!speech) return 0;
    const list = state.captionRevisions.filter((item) => item.speechId === speech.id && item.language === PRIMARY_LANGUAGE);
    return list.length ? list[0].revision : 0;
  };
  const latestCaptionText = () => {
    const speech = currentSpeech();
    if (!speech) return '';
    return state.captionRevisions.find((item) => item.speechId === speech.id && item.language === PRIMARY_LANGUAGE)?.text ?? '';
  };

  const dispatch = $((draft: OpDraft) => {
    enqueueOperation(journal, state, draft);
  });

  const toggleLowLatency$ = $(() => {
    if (!journal.lowLatency) {
      journal.lowLatency = true;
      return;
    }
    // 退出低延迟：先把攒下的频道健康度/术语变更按发生顺序重算回去，再退出。
    flushJournal(journal, state);
    journal.lowLatency = false;
  });

  const crashRestart$ = $(() => {
    // 模拟控制台崩溃后重启：未应用操作仍在日志中，重载后由恢复任务按序补算。
    window.location.reload();
  });

  const selectRoom$ = $((roomId: string) => {
    const room = state.rooms.find((item) => item.id === roomId);
    if (!room || roomId === state.activeRoomId) return;
    dispatch({ type: 'room-switch', at: now(), payload: { roomId, roomName: room.name } });
  });

  const addSpeech$ = $((values: QueueForm) => {
    dispatch({
      type: 'speech-add',
      at: now(),
      payload: { speech: { id: crypto.randomUUID(), roomId: state.activeRoomId, ...values, remainingSeconds: values.plannedSeconds, status: 'queued', updatedAt: now() } }
    });
  });

  const advanceSpeech$ = $((speechId: string, status: SpeechStatus) => {
    dispatch({ type: 'speech-advance', at: now(), payload: { speechId, status } });
  });

  const adjustTime$ = $((speechId: string, deltaSeconds: number) => {
    dispatch({ type: 'time-adjust', at: now(), payload: { speechId, deltaSeconds } });
  });

  const handoff$ = $((channelId: string) => {
    dispatch({ type: 'handoff-start', at: now(), payload: { channelId } });
  });

  const completeHandoff$ = $((channelId: string, interpreter: string) => {
    dispatch({ type: 'handoff-complete', at: now(), payload: { channelId, interpreter } });
  });

  const jitterHealth$ = $((channelId: string) => {
    const channel = state.channels.find((item) => item.id === channelId);
    if (!channel) return;
    const health = Math.max(0, Math.min(100, channel.health + Math.round((Math.random() - 0.5) * 12)));
    dispatch({ type: 'channel-health', at: now(), payload: { channelId, health } });
  });

  const publishCaption$ = $(async (values: z.infer<typeof captionSchema>) => {
    const speech = state.speechQueue.find((item) => item.roomId === state.activeRoomId && item.status === 'speaking');
    if (!speech) return;
    // 同步串行入队，修订号按提交先后分配；两位字幕员连点也不会互相覆盖。
    const draft = buildCaptionDraft(state, speech.id, captionist.value, values.text);
    if (draft) enqueueOperation(journal, state, draft);
    reset(captionForm);
  });

  const publishTwoAtOnce$ = $(() => {
    const speech = currentSpeech();
    if (!speech) return;
    dispatch(buildCaptionDraft(state, speech.id, '字幕员甲', '同段修订：字幕员甲先提交的版本')!);
    dispatch(buildCaptionDraft(state, speech.id, '字幕员乙', '同段修订：字幕员乙紧随其后的版本')!);
  });

  const approveTerm$ = $((termId: string) => {
    dispatch({ type: 'term-approve', at: now(), payload: { termId } });
  });

  const roomCaptions = () => {
    const ids = new Set(roomQueue().map((item) => item.id));
    return state.captionRevisions.filter((item) => ids.has(item.speechId) && item.language === PRIMARY_LANGUAGE);
  };

  const formatSeconds = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

  return (
    <main class={`conference-shell ${journal.lowLatency ? 'low-latency' : ''}`}>
      <header class="hero">
        <div><span class="pill">{locale.lang}</span><h1>同声传译与发言队列</h1><p>{activeRoom().name} · {activeRoom().topic}</p></div>
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <select value={state.activeRoomId} onChange$={(event) => selectRoom$((event.target as HTMLSelectElement).value)}>{state.rooms.map((room) => <option value={room.id}>{room.name}</option>)}</select>
          <button class="secondary" onClick$={toggleLowLatency$}>{journal.lowLatency ? '退出低延迟并补齐更新' : '低延迟模式'}</button>
          <button class="secondary" onClick$={crashRestart$}>模拟崩溃重启</button>
        </div>
      </header>

      {journal.lowLatency && (
        <div class="buffer-banner">
          低延迟直播中：大屏只推送队列位置 / 剩余时间 / 字幕修订号。
          已攒 <b>{pendingHealth()}</b> 条频道健康度、<b>{pendingTerms()}</b> 条术语变更，退出或重启时按顺序重放（下一序号 #{journal.nextSeq}）。
        </div>
      )}
      {recoveredCount.value > 0 && (
        <div class="recovery-banner">控制台已从崩溃中恢复：按发生顺序补算了 {recoveredCount.value} 条攒下的更新，序号与修订号保持连续，已应用操作未重复执行。</div>
      )}

      <section class="board" aria-label="低延迟大屏">
        <div class="board-cell">
          <span class="board-label">发言队列当前位置</span>
          <b class="board-value">{currentIndex() > 0 ? `第 ${currentIndex()} / ${roomQueue().length} 位` : '暂无发言'}</b>
          <span class="board-sub">{currentSpeech()?.speaker ?? '—'} · {currentSpeech()?.delegation ?? ''}</span>
        </div>
        <div class="board-cell">
          <span class="board-label">当前发言剩余时间</span>
          <b class="board-value mono">{currentSpeech() ? formatSeconds(currentSpeech()!.remainingSeconds) : '--:--'}</b>
          <span class="board-sub">{currentSpeech() ? `计划 ${formatSeconds(currentSpeech()!.plannedSeconds)}` : ''}</span>
        </div>
        <div class="board-cell">
          <span class="board-label">字幕修订号</span>
          <b class="board-value mono">v{currentRevision()}</b>
          <span class="board-sub">{latestCaptionText() || '尚无字幕'}</span>
        </div>
      </section>

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
                {speech.status === 'speaking' && <><button onClick$={() => advanceSpeech$(speech.id, 'done')}>结束</button><button class="secondary" onClick$={() => adjustTime$(speech.id, -60)}>减1分钟</button></>}
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

        <aside class="panel buffered-panel">
          <div style="display:flex;justify-content:space-between;align-items:center"><h2>频道与译员</h2>{journal.lowLatency && <span class="frozen-tag">健康度攒批中 · {pendingHealth()} 条待推</span>}</div>
          {roomChannels().map((channel) => (
            <div style="padding:12px 0;border-bottom:1px solid #e6efee" key={channel.id}>
              <div style="display:flex;justify-content:space-between"><b>{channel.language} · {channel.interpreter}</b><span class="pill">{channel.status}</span></div>
              <div class="decorative" style="margin:8px 0"><Progress.Root value={channel.health} max={100} /></div>
              {journal.lowLatency
                ? <div class="frozen-value">健康度 {channel.health}（现场波动先攒着，不推大屏）</div>
                : <div style="font-size:12px;color:#59747b;margin:6px 0">频道健康度 {channel.health}</div>}
              <div style="display:flex;gap:8px;flex-wrap:wrap">
                <button class="secondary" onClick$={() => jitterHealth$(channel.id)}>模拟现场波动</button>
                <button class="secondary" onClick$={() => handoff$(channel.id)}>开始交接</button>
                {channel.status === 'handoff' && <button onClick$={() => completeHandoff$(channel.id, `替补译员-${channel.language}`)}>完成交接</button>}
              </div>
              {channel.relievedSpeechId && <div class="handoff-note">接班仅服务当前发言，主持人切下一位后频道交还 {channel.previousInterpreter}</div>}
            </div>
          ))}
          <h3>实时字幕修正（修订按提交先后排队，不互相覆盖）</h3>
          {currentSpeech() ? <>
            <select value={captionist.value} onChange$={(event) => captionist.value = (event.target as HTMLSelectElement).value}>
              <option>字幕员甲</option>
              <option>字幕员乙</option>
            </select>
            <CaptionForm onSubmit$={publishCaption$}>
              <CaptionField name="text">{(field, props) => <textarea {...props} rows={3} value={field.value} onInput$={(event) => field.value = (event.target as HTMLTextAreaElement).value} placeholder="输入或修正当前字幕" />}</CaptionField>
              <button type="submit" style="margin-top:8px">提交新版字幕</button>
            </CaptionForm>
            <button class="secondary" style="margin-top:8px" onClick$={publishTwoAtOnce$}>模拟两位字幕员同时提交同一段</button>
          </> : <p>当前没有发言中的代表。</p>}
          {roomCaptions().map((caption) => (
            <div style="margin-top:10px;padding:10px;background:#f1f8f7;border-radius:10px" key={caption.id}>
              <b>v{caption.revision} · 译员：{caption.interpreter} · {caption.captionist} · #{caption.seq}</b>
              <p style="margin:6px 0 0">{caption.text}</p>
            </div>
          ))}
        </aside>
      </section>

      <section class="grid" style="margin-top:18px">
        <article class="panel buffered-panel">
          <div style="display:flex;justify-content:space-between;align-items:center"><h2>术语库</h2>{journal.lowLatency && <span class="frozen-tag">术语变更攒批中 · {pendingTerms()} 条待推</span>}</div>
          {state.terms.map((term) => <div class="queue-row" key={term.id}><span /><div><b>{term.phrase}</b><div>{term.translation} · {term.language}</div></div><span class="pill">{term.approved ? '已批准' : '待审'}</span><button disabled={term.approved} onClick$={() => approveTerm$(term.id)}>批准</button></div>)}
        </article>
        <article class="panel">
          <h2>操作与交接时间线（按日志序号）</h2>
          {state.audits.filter((audit) => audit.roomId === state.activeRoomId).sort((a, b) => b.seq - a.seq).slice(0, 12).map((audit) => <div style="padding:10px 0;border-bottom:1px solid #e6efee" key={audit.id}><small>#{audit.seq} · {new Date(audit.at).toLocaleTimeString()}</small><div>{audit.message}</div></div>)}
        </article>
      </section>
    </main>
  );
});

export const head: DocumentHead = {
  title: '国际会议同声传译控制台',
  meta: [{ name: 'description', content: '发言队列、多语种频道、术语、译员交接与实时字幕修正原型，低延迟模式支持事件日志与崩溃恢复' }]
};

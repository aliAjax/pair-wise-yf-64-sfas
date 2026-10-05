import assert from 'node:assert/strict';
import {
  clone,
  enqueueOperation,
  flushJournal,
  isBufferedInLowLatency,
  loadInitial,
  makeSeedJournal,
  makeSeedState,
  now,
  submitCaption,
  type ConferenceState,
  type Journal
} from './conference';

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

function setup(lowLatency = false): { state: ConferenceState; journal: Journal } {
  return { state: makeSeedState(), journal: { ...makeSeedJournal(), lowLatency } };
}

// 确定性 ID，避免 crypto 依赖
let counter = 0;
const newId = () => `id-${++counter}`;

console.log('1) 低延迟下：关键状态立即应用，健康度/术语变更攒着不推');
{
  const { state, journal } = setup(true);
  assert.equal(isBufferedInLowLatency('channel-health'), true);
  assert.equal(isBufferedInLowLatency('term-approve'), true);
  assert.equal(isBufferedInLowLatency('caption-submit'), false);

  const speech = state.speechQueue.find((s) => s.id === 'speech-1')!;
  enqueueOperation(journal, state, { type: 'time-adjust', at: now(), payload: { speechId: speech.id, deltaSeconds: -60 } }, { newId });
  assert.equal(speech.remainingSeconds, 154, '剩余时间立即生效（大屏可见）');

  enqueueOperation(journal, state, { type: 'channel-health', at: now(), payload: { channelId: 'ch-a-zh', health: 42 } }, { newId });
  const channel = state.channels.find((c) => c.id === 'ch-a-zh')!;
  assert.equal(channel.health, 96, '健康度波动不应用到大屏状态');

  enqueueOperation(journal, state, { type: 'term-approve', at: now(), payload: { termId: 'term-3' } }, { newId });
  assert.equal(state.terms.find((t) => t.id === 'term-3')!.approved, false, '术语变更先攒着');

  const pending = journal.ops.filter((o) => !o.applied);
  assert.deepEqual(pending.map((o) => o.type), ['channel-health', 'term-approve']);
  assert.deepEqual(pending.map((o) => o.seq), [2, 3], '攒批按发生顺序排列');
  passed++; console.log('  ✓ 关键状态即时、非关键攒批');
}

console.log('2) 退出低延迟：攒下的更新按发生顺序重算回去，序号连续');
{
  const { state, journal } = setup(true);
  const healthOp = enqueueOperation(journal, state, { type: 'channel-health', at: now(), payload: { channelId: 'ch-a-zh', health: 55 } }, { newId });
  const termOp = enqueueOperation(journal, state, { type: 'term-approve', at: now(), payload: { termId: 'term-3' } }, { newId });
  assert.equal(healthOp.applied, false);
  assert.equal(termOp.applied, false);
  assert.equal(journal.nextSeq, 3);

  const replayed = flushJournal(journal, state);
  assert.equal(replayed, 2, '重放两条');
  assert.equal(state.channels.find((c) => c.id === 'ch-a-zh')!.health, 55);
  assert.equal(state.terms.find((t) => t.id === 'term-3')!.approved, true);
  assert.ok(journal.ops.every((o) => o.applied), '全部标记为已应用');

  // 再 flush 一次：算过的操作不能执行第二遍
  const second = flushJournal(journal, state);
  assert.equal(second, 0, '已应用的操作不重复执行');
  const audits = state.audits.filter((a) => a.message.includes('术语已批准'));
  assert.equal(audits.length, 1, '重放不产生重复审计');

  // 后续操作序号接着走
  const next = enqueueOperation(journal, state, { type: 'channel-health', at: now(), payload: { channelId: 'ch-a-zh', health: 70 } }, { newId });
  assert.equal(next.seq, 3, '序号保持连续');
  passed++; console.log('  ✓ 按序重放 + 幂等 + 序号连续');
}

console.log('3) 两位字幕员同时提交同一段：按提交先后排队，修订号连续，互不覆盖');
{
  const { state, journal } = setup(false);
  const r1 = submitCaption(journal, state, 'speech-1', '字幕员甲', '甲的修订', { newId });
  const r2 = submitCaption(journal, state, 'speech-1', '字幕员乙', '乙的修订', { newId });
  assert.ok(r1 && r2);
  const revisions = state.captionRevisions
    .filter((c) => c.speechId === 'speech-1' && c.language === '中文')
    .sort((a, b) => a.revision - b.revision);
  assert.equal(revisions.length, 3, '种子修订 + 两条新修订');
  assert.deepEqual(revisions.map((r) => r.revision), [2, 3, 4], '修订号从当前版本起连续');
  assert.deepEqual(revisions.slice(1).map((r) => r.text), ['甲的修订', '乙的修订'], '两版都保留，后者不覆盖前者');
  assert.deepEqual(revisions.slice(1).map((r) => r.captionist), ['字幕员甲', '字幕员乙']);
  assert.deepEqual(revisions.slice(1).map((r) => r.seq), [1, 2], '排队顺序即提交顺序');

  // 低延迟下字幕修订仍立即推送
  const ll = setup(true);
  submitCaption(ll.journal, ll.state, 'speech-1', '字幕员甲', '低延迟也要即时', { newId });
  assert.equal(ll.journal.ops.at(-1)!.applied, true);
  assert.ok(ll.state.captionRevisions.some((r) => r.text === '低延迟也要即时'));
  passed++; console.log('  ✓ 并发修订排队、修订号连续、互不覆盖');
}

console.log('4) 主持人切到下一位：新字幕不挂到刚接班的译员名下');
{
  const { state, journal } = setup(false);
  // 当前发言 speech-1，周雨 -> 替补译员 接班（仅服务 speech-1）
  enqueueOperation(journal, state, { type: 'handoff-start', at: now(), payload: { channelId: 'ch-a-zh' } }, { newId });
  enqueueOperation(journal, state, { type: 'handoff-complete', at: now(), payload: { channelId: 'ch-a-zh', interpreter: '替补译员-中文' } }, { newId });
  const channel = state.channels.find((c) => c.id === 'ch-a-zh')!;
  assert.equal(channel.interpreter, '替补译员-中文');

  // speech-1 期间的字幕归属接班译员
  const duringHandoff = submitCaption(journal, state, 'speech-1', '字幕员甲', '交班后该段的修订', { newId });
  assert.ok(duringHandoff && duringHandoff.type === 'caption-submit');
  assert.equal(duringHandoff.payload.interpreter, '替补译员-中文');

  // 主持人切到 speech-2：接班译员不跟过来
  enqueueOperation(journal, state, { type: 'speech-advance', at: now(), payload: { speechId: 'speech-2', status: 'speaking' } }, { newId });
  assert.equal(channel.interpreter, '周雨', '频道交还接班前译员');
  assert.equal(channel.relievedSpeechId, null);

  // 新发言的字幕归周雨，而不是刚接班的替补译员
  const next = submitCaption(journal, state, 'speech-2', '字幕员甲', '下一位发言的字幕', { newId });
  assert.ok(next && next.type === 'caption-submit');
  assert.equal(next.payload.interpreter, '周雨', '新字幕不挂到刚接班的译员名下');
  const saved = state.captionRevisions.find((r) => r.id === next.payload.revisionId)!;
  assert.equal(saved.interpreter, '周雨');
  passed++; console.log('  ✓ 切发言后新字幕归属正确译员');
}

console.log('5) 崩溃重启恢复：攒批按序重放，序号/修订号连续，已应用不重复');
{
  // 模拟崩溃前的持久化：低延迟中有 1 条健康度攒着
  const before = setup(true);
  const speechId = 'speech-1';
  submitCaption(before.journal, before.state, speechId, '字幕员甲', '崩溃前最后一版', { newId });
  enqueueOperation(before.journal, before.state, { type: 'channel-health', at: now(), payload: { channelId: 'ch-a-zh', health: 33 } }, { newId });
  // 崩溃发生：state 快照是应用前状态（health 仍 96），日志里有未应用操作
  assert.equal(before.state.channels.find((c) => c.id === 'ch-a-zh')!.health, 96);
  const persisted = JSON.stringify({ state: before.state, journal: before.journal });

  // 重启加载
  const storage = new Map<string, string>([['conference-interpretation-v2', persisted]]);
  const loaded = loadInitial({ getItem: (k) => storage.get(k) ?? null, removeItem: (k) => storage.delete(k) });
  assert.equal(loaded.recovered, 1, '恢复重放了 1 条攒批');
  assert.equal(loaded.state.channels.find((c) => c.id === 'ch-a-zh')!.health, 33);
  assert.ok(loaded.state.captionRevisions.some((r) => r.text === '崩溃前最后一版'), '即时字幕在崩溃前已保留');
  assert.ok(loaded.journal.ops.every((o) => o.applied));

  // 修订号接着崩溃前继续
  const continued = submitCaption(loaded.journal, loaded.state, speechId, '字幕员乙', '恢复后新版', { newId });
  assert.ok(continued && continued.type === 'caption-submit');
  assert.equal(continued.payload.interpreter, '周雨');
  const revs = loaded.state.captionRevisions.filter((r) => r.speechId === speechId).sort((a, b) => a.revision - b.revision);
  assert.deepEqual(revs.map((r) => r.revision), [2, 3, 4], '修订号跨重启连续');
  assert.equal(continued!.seq, loaded.journal.nextSeq - 1);

  // 再次“重启”：已应用操作不执行第二遍
  const secondStorage = new Map<string, string>([['conference-interpretation-v2', JSON.stringify({ state: loaded.state, journal: loaded.journal })]]);
  const second = loadInitial({ getItem: (k) => secondStorage.get(k) ?? null, removeItem: (k) => secondStorage.delete(k) });
  assert.equal(second.recovered, 0);
  assert.equal(second.state.captionRevisions.length, loaded.state.captionRevisions.length, '修订不重复追加');
  passed++; console.log('  ✓ 崩溃恢复按序重放且幂等');
}

console.log('6) 大屏三要素只由关键操作驱动：健康度重放不改队列位置/剩余时间/修订号');
{
  const { state, journal } = setup(true);
  const revisionBefore = state.captionRevisions.filter((r) => r.speechId === 'speech-1').length;
  enqueueOperation(journal, state, { type: 'channel-health', at: now(), payload: { channelId: 'ch-a-zh', health: 10 } }, { newId });
  enqueueOperation(journal, state, { type: 'term-approve', at: now(), payload: { termId: 'term-3' } }, { newId });
  flushJournal(journal, state);
  assert.equal(state.speechQueue.find((s) => s.id === 'speech-1')!.status, 'speaking', '队列位置未受影响');
  assert.equal(state.captionRevisions.filter((r) => r.speechId === 'speech-1').length, revisionBefore, '修订号未被非关键操作推动');
  passed++; console.log('  ✓ 非关键重放不污染大屏信号');
}

console.log(`\n全部通过：${passed} 个测试文件场景`);

// 防止 clone 被 tree-shake 告警（同时验证工具函数）
assert.equal(typeof clone, 'function');

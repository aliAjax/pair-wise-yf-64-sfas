# 国际会议同声传译和发言队列控制

源提示词摘要：主持人维护代表发言队列、剩余时间、议题和临时插话；翻译团队维护多语种频道、术语和译员交接；字幕人员修正实时文本。队列调整保留版本，发言者切换后旧译文不会误绑定，并提供低延迟大屏模式和多会议厅隔离。

## 技术栈

Qwik City、TypeScript、Qwik UI、Qwik stores、TanStack Query、Modular Forms、Zod、qwik-speak。

## 本地运行

```bash
npm install
npm run dev
```

开发端口：`62029`

## 可用流程

- 多会议厅独立维护代表、议题和发言队列，切换厅时数据互不影响。
- 发言人从排队、发言中、完成到跳过，支持临时插话和剩余时间调整。
- 多语种频道维护译员、术语和交接；交接仅覆盖当前发言，主持人切下一位后频道交还原译员，新字幕不会误挂到刚接班的译员。
- 实时字幕按“修订日志”逐版保留：两位字幕员提交同一段时按提交先后排队，修订号连续，互不覆盖。
- 低延迟大屏只推送三个信号：发言队列当前位置、当前发言剩余时间、字幕修订号；频道健康度与术语变更先攒批，退出低延迟或崩溃重启后按发生顺序重放，序号/修订号连续，已应用操作幂等不重复执行。
- 数据以事件日志保存在浏览器 localStorage，刷新与崩溃重启后自动恢复到中断前状态（v1 存档自动迁移）。

## 核心模块与测试

事件日志与重放逻辑在 `src/lib/conference.ts`（框架无关的纯函数 reducer），
`src/lib/conference.test.ts` 覆盖攒批、排队、归属与崩溃恢复，可用以下方式运行：

```bash
npx esbuild src/lib/conference.test.ts --bundle --platform=node --format=esm --outfile=tmp/test.mjs && node tmp/test.mjs
```

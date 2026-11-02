# DSH 多对话并发能力调研（只读源码结论）

源码位置：`<DSH 源码检出目录>`（只读，未修改）。
本地插件：`plugins/dsh-codebuddy-acp`（下文路径不带前缀者指该插件）。

## 1. Host 如何调用 LLM 适配器：没有全局闸门

注册与契约：

- `packages/llm/llm/src/index.ts:401` `registerAdapter(providers, adapter): AdapterRegistrationHandle`
- `packages/llm/llm/src/index.ts:208` `abstract class LlmAdapter`；`:290-295` 默认 `prepareCall` 只是把 `resolveModel` 与 `stream` 打包；`:302` 唯一的抽象方法 `abstract stream(options)`
- `packages/llm/llm/src/index.ts:355-360` `LlmRuntime` 的私有状态只有 `adapters` / `directory` / `discoveries` 三张 Map——**没有任何 per-provider 的 in-flight 集合、队列或信号量**。

调度路径：

```
1168:   * @returns the chunk stream, possibly wrapped by `llm/stream` listeners.
1170:   stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
1171:     return this.streamWithRegistration(options)
1174:   private streamWithRegistration(options, prepared?) {
1178:     return this.ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(options, prepared))
```

```
1068:   private async * adapterStream(options, prepared?) {
1074:       const registration = prepared?.registration ?? this.registration(options.provider)
1080:         const adapterCall = await adapter.prepareCall(options.provider, options.model, options.signal)
1122:       const stream = dispatch(this.forAdapter(projectedOptions, adapter))
1123:       iterator = stream[Symbol.asyncIterator]()
```

每次调用都新建一个 generator + iterator（`:1122-1123`），没有对同一个 adapter 实例做互斥。因此**适配器契约允许多个 `stream()` 并发存在**，并发与否完全取决于适配器实现。

`packages/llm/llm/src/index.ts:999-1009` 只限制「一次 prepared call 只能 dispatch 一次」（`dispatched` 标志），这是**单次调用**的约束，不是 provider 级别的。

结论：Host 侧不存在「同一 provider 同时只能一个请求」的闸门/队列/锁。

## 2. `GenerateOptions.sessionId`

`packages/llm/llm/src/types.ts:586-590`：

```ts
  /**
   * Session identity stamped by the loop for request routing. Replay uses it
   * to separate cursors; adapters may map it to model-hidden transport metadata.
   */
  sessionId?: Branded<'SessionId'>
```

由 agent loop 盖章：`packages/core/agent-loop/src/agent.ts:735-742`

```ts
    const request = markAgentLoopRequest(Object.freeze({
      ...header.config,
      messages: boundaryMessages,
      toolHistory: session.toolHistory(),
      ...header.tools !== undefined ? { tools: header.tools } : {},
      sessionId: this.session.id,
      signal,
    }))
```

`this.session.id` 就是稳定会话 id：`packages/core/agent/src/types.ts:16-19` 中 `Agent.id: SessionId` 与 session 同体；注册表 `packages/core/agent/src/index.ts:591-593` `get(id: SessionId)` 用它查活体 agent；`packages/api/session-controller/src/index.ts:268-269` `resolveAgent(sessionId)` 同一套寻址。标题辅助调用同样带它：`packages/session/session-title-llm/src/index.ts:263`；压缩带它：`packages/compaction/compaction-basic/src/summarizer.ts:159`。

所以 `options.sessionId` 稳定等于 DSH 会话 id；`ctx.agents.get(options.sessionId)` 可得该会话 agent。**但辅助调用之外，`sessionId` 可选**——直接用 `ctx.llm.stream()` 的手工请求可以不带，因此适配器不该把它当唯一身份。

## 3. 应用层：两个会话可以同时跑 turn

- per-agent 状态机：`packages/core/agent-loop/src/agent.ts:156-158`
  ```ts
    get status(): AgentStatus {
      return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'
    }
  ```
  `running` 是**每个 agent 自己的** phase，没有全局单例。
- `packages/core/agent-loop/src/agent.ts:230-250` `wakeDriver()` 每个 agent 起自己的 `kick()` 驱动；`:268-270` `while (await this.turn()) {}`。A、B 两个会话互不阻塞。
- 只有一个「互斥」是**同 agent 内**的：`agent.ts:199-200`
  ```ts
    runMaintenance<T>(job): Promise<T> {
      if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
  ```
  仅防同会话的 maintenance 与 turn 重叠，跨会话无约束。
- Host 侧 `busy` 也是按会话：`packages/api/session-controller/src/list.ts:125`
  ```ts
        running: this.ctx.agents.get(session.id)?.status === 'running',
  ```
  `commands.ts:304-350` 的 prompt 准入对同一 agent 只可能 `agent.followup()`/`steer()` 入 inbox，`session/agent-busy` 是错误兜底而非全局锁。
- Web 侧输入框**不因别的会话在跑而禁用**：`packages/client/ui-conversation/src/client/skeleton/InputBar.tsx:72` `const running = useSession(s => s.running) ?? false`，`:150-155`
  ```ts
    // Running input stays free; locked = session removed, the
    // inert no-workspace state, the machine faces absent (no session), or a
    // parent-offline continuable child. An owner block also disables input;
    const disabled = removed || inert || !live || blocked !== undefined || parentOffline
  ```
  `running` 只影响「Send 变成 Queue/Steer 还是 Stop」，不 disable 其它会话。

结论：Host + GUI 都允许两个会话同时跑 turn；`running` 是逐会话的。

## 4. `purpose` 辅助调用在什么上下文、是否与主 turn 并发

- 标题：`packages/session/session-title/src/index.ts:555-567` 从 `llm/stream` 水位触发，`:577` `this.defer(async () => {`，`:746-752`
  ```ts
    private defer(task: () => Promise<void>): void {
      const run = Promise.resolve().then(async () => {
  ```
  即**脱离主 turn 的游离 promise**，不 await → 与主 turn 并发。发起方 `session-title-llm/src/index.ts:252-266` 用 `ctx.llm.prepareCall(...)` + `call.stream(options)`（`purpose: 'session-title'`）。
- 压缩：`packages/compaction/compaction-basic/src/index.ts:157-163` 在 `agent/pre-step` 里 `await this.compactIfNeeded(...)`，是**同步串行**在派发请求之前，不与本会话主 turn 并发（跨会话仍可能并发）。手动 `/compact` 走 `agent.runMaintenance`（`:414`），因此与该会话的 turn 互斥。
- 适配器侧：`adapter.js:1956-1958`
  ```js
      if (options.purpose !== undefined) {
        yield* this.#auxiliary(options, options.purpose)
        return
      }
  ```
  `#auxiliary`（`:2296-2320`）只产出本地拼接文本，**不碰 ACP、不碰连接闸门**。所以 purpose 调用不会和你抢 CodeBuddy。

## 5. 客户端插件：`sidebar.panellist` 与 `main`

- 声明：`packages/client/ui-sidebar/src/client/contract/slots.ts:32-38`
  ```ts
      /**
       * Global panel icons. Each list id addresses the matching main panel;
       * the sidebar owns the button and resolves its label from list metadata.
       */
      'sidebar.panellist': { kind: 'list'; scope: 'root'; owner: SidebarPanelIconOwnerProps }
      'sidebar.panellist.actions': { kind: 'list'; scope: 'root'; owner: SidebarPanelActionsOwnerProps }
  ```
- owner props：同文件 `:72-78` → `{ size: number; active: boolean }`（只有这两个，**没有 loading**）。
- 渲染侧：`packages/client/ui-sidebar/src/client/SidebarRoot.tsx:83`
  ```tsx
            {renderSlot('sidebar.panellist', { size: wide ? 16 : 18, active }, { only: id })}
  ```
  `active` 来自 `usePanelInfo(info => info.activePanelId === id)`（`:68`）。
- 约定文档：`packages/client/ui-sidebar/README.zh.md:38`（图标组件 + `id`/`order`/`label`，同 id 寻址 layout 的 `main` keyed slot，选中不存在的主面板会抛错）；`:40`（`sidebar.panellist.actions` 的 entries/onOpen/onPinnedChange/onDismiss）；`docs/subsystems/slots.md:13`。
- `main`：`packages/client/ui-layout/src/client/index.ts:73` `'main': { kind: 'keyed'; scope: 'root' }`；`slot-catalog.ts:2294-2295`
  > Central panel selected by sidebar entry id. The reserved `conversation` key hosts the Conversation; **other keys receive no Session binding.**
  这也是本插件面板拿不到会话上下文的原因。
- `t` 从哪来：`packages/client/ui-slots/src/index.ts:93-95`
  ```ts
  export type PropsLocale<N> = N extends keyof LocaleNamespaceMap & string
    ? {
      /** Translate a dictionary key of the declared namespace (or the shared common vocabulary). */
      t: TranslateNS<N>
  ```
  注册时声明 `locale: NS`（`:830-835`：「Declaring it puts the framework-synthesized `t` seat … on the component props」）。文档口径：`docs/subsystems/slots.md:78` `| localized t function | the registration's locale namespace | PropsLocale<N> |`。
  注册失败/加载态没有框架支持——面板自己管（本插件 `client.js:429` `{ status: 'loading', data: null, error: null }`，`:508-510` 自绘 loading 行）。
- 本插件现状（`plugins/dsh-codebuddy-acp/client.js:882-891`）：
  ```js
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }))
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: 'codebuddy', locale: NS, inject: () => ({ t }) },
          ConsolePage))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: 'codebuddy', order: 25, label: () => t('title'), locale: NS },
  ```

## 6. 主题 token（浅/深）

源：`packages/client/ui-theme/src/styles/design-platform.css`

浅色（`body {}`，`:176` 起）：

| token | 行 | 值 | 解析 |
|---|---|---|---|
| `--dsw-alias-button-primary-fill` | 214 | `var(--dsw-alias-brand-primary)` | 202 → `--dsw-static-neutral-bluish-1000` = `rgb(15, 17, 21)`（:57） |
| `--dsw-alias-label-primary-foreground` | 236 | `var(--dsw-static-neutral-bluish-00)` | `rgb(255,255,255)`（:56） |
| `--dsw-alias-button-primary-hover` | 215 | `var(--dsw-static-neutral-bluish-750)` | `rgb(67,69,74)`（:70） |
| `--dsw-alias-button-primary-dimmed` | 213 | `var(--dsw-static-neutral-bluish-100)` | `rgb(235,238,242)`（:58） |

深色（`body[data-ds-dark-theme] {}`，`:300` 起）：

| token | 行 | 值 | 解析 |
|---|---|---|---|
| `--dsw-alias-button-primary-fill` | 338 | `var(--dsw-alias-brand-primary)` | 326 → `--dsw-static-neutral-bluish-50` = `rgb(249,250,251)`（:151） |
| `--dsw-alias-label-primary-foreground` | 360 | `var(--dsw-static-neutral-bluish-1000)` | `rgb(15,17,21)`（:143） |
| `--dsw-alias-button-primary-hover` | 339 | `var(--dsw-static-neutral-bluish-100)` | `rgb(235,238,242)`（:144） |
| `--dsw-alias-button-primary-dimmed` | 337 | `var(--dsw-static-neutral-bluish-750)` | `rgb(67,69,74)`（:156） |

**动态加载的 web 插件能不能用这些 token？能。**
- token 通过 `document.head` 上的 `<style>` 注入到 `body` 作用域：`packages/client/ui-theme/src/client/styles.ts:17`（`design-platform.css` 在 STYLES 表里）、`:54-62` 每个样式表各自建 `<style>` 插到 `document.head`。它们是运行时 CSS 变量，不是 TS 导入。
- 动态插件的样式也走 document：`packages/extensions/cordis-client-runner/src/client/evaluator.ts:89-94`
  ```ts
    insert(css: string): () => void {
      const tag = document.createElement('style')
      tag.dataset.dyn = this.pluginId
      tag.textContent = css
      document.head.append(tag)
  ```
- 官方明确要求这么做：`packages/extensions/cordis-client-runner/src/client/slot-catalog.ts:72`
  > You cannot `import` anything … ship CSS through `styles.insert(css)`. **Use the theme CSS variables (`var(--dsw-alias-bg-layer-1)`, `var(--dsw-alias-label-primary)`, …) instead of literal colors**, or your contribution breaks in the other color scheme.

注意：`--dsw-alias-button-primary-fill` 在两个主题下**语义相反**（浅色近黑、深色近白），配 `--dsw-alias-label-primary-foreground` 正好是「黑按钮白字 / 白按钮黑字」；只用一个而不配前景观会串色。

## 7. 「只能在一个对话里用」的真因（在插件自身）

插件内部有两级闸门，`adapter.js`：

- 会话级（合理）：`1409-1410` `this.tails = new Map()`；`1937-1948` `#acquire(key)`；`2001` `const release = await this.#acquire(sessionKey)`。
- **连接级（跨会话，这才是病灶）**：`927-928`
  ```js
      /** 连接级串行闸门：同一进程内的多轮 prompt 不能并发。 */
      this.tail = Promise.resolve()
  ```
  `941-952` `acquire()`（注释：「同一个 CodeBuddy 进程里的多条会话不能并发跑 prompt」），`2191`
  ```js
        releaseGate = await shared.acquire()
  ```
  而连接是**按 cwd 共享**的：`1806-1825` `#shared(cwd)` + `1405-1406` `this.connections = new Map()`。两个 DSH 会话大多同一工作目录 → 同一个 `SharedConnection` → 第二个会话整轮卡在 `acquire()` 里等第一个跑完。这就是「同时只能一个对话用 CodeBuddy」。

  是否必须？`docs/acp-findings.md:814` 把「并发 prompt（同 session 两个请求）」列为**未测**项——闸门是保守假设，不是实测结论。

## 8. 可行建议（按性价比）

1. **先验证，再拆闸门**（最高优先）：在 probe 里对同一 CodeBuddy 进程的两个不同 ACP `sessionId` 同时发 `session/prompt`，看是否都正常流式 + 是否 `-32603`。ACP 协议本身按 sessionId 分帧（`acp.js:279-282` `updateListeners` 按 sessionId 分发、`:192` `pending` 按 JSON-RPC id 匹配），并发大概率可行。验证通过后把 `SharedConnection.acquire()` 从「连接级」降级为「按 ACP sessionId 级」，保留 `#acquire(sessionKey)`。
2. **闸门要有超时/可观测**：现在第二个会话是静默等待（`await previous.catch(() => {})`，无日志无进度）。至少 `logger.info` 打印「排队等待中」，避免用户以为卡死。
3. **Host 侧不需要改**：`LlmRuntime` 无闸门（见 §1），不要指望上游加。
4. **purpose 调用已经绕开闸门**（§4），无需处理；但若将来让 title 真调 CodeBuddy，必须走独立 sessionId，否则会被同一闸门串起来。
5. **面板/图标侧**：`sidebar.panellist` 只有 `{size, active}`，没有 loading 契约；`main` 的非 `conversation` key 拿不到 Session 绑定。所以面板要做「某会话是否在跑」的展示，必须自己经由 `ctx` 服务/`inject` 取数据（如本插件已用的 `ctx.get('agents')`/`sessions`），不要指望 slot props。
6. **配色**：主按钮一律用 `--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-foreground` 成对，hover 用 `-hover`，禁用用 `-dimmed`；不要写字面色值。

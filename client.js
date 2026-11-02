/**
 * dsh-codebuddy-acp — Web 端半身（侧栏控制台）。
 *
 * 侧栏新增一个 CodeBuddy 图标，点开是同一个主面板：
 *
 * - 顶部 KPI：账号里**真实的剩余积分**，以及今日 / 本月 / 累计的积分消耗；
 * - 账号与积分：账号与站点域、额度包明细、今日签到状态、一键领取每日积分（复用本机 CLI 登录态）；
 * - 模型管理：勾选启用哪些模型、调整顺序、指定默认模型，并显示每个模型的积分倍率；
 *   保存后立即影响模型选择器（Host 侧适配器按这份策略过滤 `listModels`）；
 * - 用量明细：按模型的今日 / 累计积分与调用次数，以及最近调用流水。
 *
 * 页面数据全部来自同源接口 `/api/codebuddy-console`，由 Host 半身提供。
 * 凭据只存在 Host 侧，页面拿到的永远只是脱敏摘要。
 *
 * @module dsh-codebuddy-acp/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-codebuddy-acp',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'dsh-codebuddy-acp'
    const API = 'api/codebuddy-console'
    /** 回放工具名（与 Host 侧 config.toolName 的默认值保持一致）。 */
    const TOOL_NAME = 'codebuddy_tool'

    /**
     * 工具家族：决定徽章文案与配色。
     *
     * 为什么要分家族：所有 CodeBuddy 工具在 DSH 里只有一个回放工具名，DSH 自带的
     * 「按工具名换图标/标题」完全用不上。于是同一轮里 Read/Bash/Edit 三个卡片长得一模一样，
     * 看上去就是一坨堆叠的灰框。这里按**真实工具名**（`Read` / `Bash` / `Edit` / `Grep`…）
     * 归到家族，各自一套徽章文案、颜色和摘要规则。
     */
    const TOOL_FAMILIES = {
      read: { key: 'toolNameRead', color: '#2f6fed', bg: 'rgba(47,111,237,.14)' },
      write: { key: 'toolNameWrite', color: '#a855f7', bg: 'rgba(168,85,247,.14)' },
      edit: { key: 'toolNameEdit', color: '#d97706', bg: 'rgba(217,119,6,.16)' },
      bash: { key: 'toolNameBash', color: '#059669', bg: 'rgba(5,150,105,.14)' },
      search: { key: 'toolNameSearch', color: '#0891b2', bg: 'rgba(8,145,178,.14)' },
      fetch: { key: 'toolNameFetch', color: '#4f46e5', bg: 'rgba(79,70,229,.14)' },
      task: { key: 'toolNameTask', color: '#db2777', bg: 'rgba(219,39,119,.14)' },
      todo: { key: 'toolNameTodo', color: '#7c3aed', bg: 'rgba(124,58,237,.14)' },
      agent: { key: 'toolNameAgent', color: '#0284c7', bg: 'rgba(2,132,199,.14)' },
      other: { key: 'toolKindOther', color: '#64748b', bg: 'rgba(100,116,139,.14)' },
    }

    /** 真实工具名（小写、去非字母字符）→ 家族。未知工具回落到 ACP 的 `kind`。 */
    const TOOL_FAMILY_BY_NAME = {
      read: 'read', readfile: 'read', readimage: 'read', notebookread: 'read',
      ls: 'read', list: 'read', listdir: 'read', view: 'read',
      write: 'write', writefile: 'write', createfile: 'write', notebookwrite: 'write',
      edit: 'edit', multiedit: 'edit', notebookedit: 'edit', applypatch: 'edit', patch: 'edit',
      bash: 'bash', shell: 'bash', powershell: 'bash', execute: 'bash', runcommand: 'bash',
      bashoutput: 'bash', killshell: 'bash', terminal: 'bash',
      grep: 'search', glob: 'search', search: 'search', find: 'search', websearch: 'search',
      webfetch: 'fetch', fetch: 'fetch', http: 'fetch', curl: 'fetch',
      task: 'task', taskcreate: 'task', taskupdate: 'task', tasklist: 'task', taskget: 'task',
      todo: 'todo', todowrite: 'todo', todoread: 'todo',
      agent: 'agent', subagent: 'agent', skill: 'agent', delegate: 'agent',
    }

    /** ACP `kind` → 家族（工具名认不出来时的兜底）。 */
    const TOOL_FAMILY_BY_KIND = {
      read: 'read', edit: 'edit', delete: 'edit', move: 'edit',
      search: 'search', execute: 'bash', fetch: 'fetch', think: 'other', other: 'other',
    }

    /**
     * 判断一次调用属于哪个家族。
     * @param {string} name 真实工具名（如 `Read` / `Bash`）。
     * @param {string} kind ACP kind。
     * @returns {string} 家族 id。
     */
    function toolFamilyOf(name, kind) {
      const slug = String(name ?? '').toLowerCase().replace(/[^a-z]/g, '')
      const byName = TOOL_FAMILY_BY_NAME[slug]
      if (byName !== undefined) return byName
      return TOOL_FAMILY_BY_KIND[kind] ?? 'other'
    }

    /** 中文文案。 */
    const ZH = {
      title: 'CodeBuddy',
      subtitle: '剩余积分、每日签到与模型控制台',
      refreshing: '刷新中…',
      loading: '正在读取 CodeBuddy 数据…',
      error: '读取失败',
      retry: '重试',
      remaining: '剩余积分',
      remainingHint: '来自 CodeBuddy 账号的额度包',
      noAccount: '未找到 CodeBuddy 登录态',
      loginHint: '剩余积分与每日签到直接使用本机 CodeBuddy CLI 的登录态读取，插件不复制也不上报凭据。',
      refreshCredits: '刷新积分',
      account: '账号与积分',
      user: '账号',
      domain: '站点域',
      authType: '登录方式',
      creditTotal: '可用积分',
      creditPackages: '额度包',
      noPackage: '账号下没有可用的额度包',
      packageName: '额度包',
      packageRemain: '剩余',
      packageUsed: '已用',
      packageExpire: '有效期至',
      checkin: '每日积分',
      checkinClaim: '领取每日积分',
      checkinClaimed: '今日已领取',
      checkinUnavailable: '活动不可用',
      checkinDone: '领取成功',
      checkinStreak: '连续签到 {n} 天',
      checkinToday: '今日获得 {n} 积分',
      checkinPending: '今日还未领取',
      checkinInactive: '当前没有可参与的签到活动',
      calls: '调用次数',
      tokens: 'Token',
      today: '今日',
      thisMonth: '本月',
      total: '累计',
      models: '模型管理',
      modelsHint: '勾选的模型才会出现在 DSH 的模型选择器里；顺序即展示顺序。积分倍率表示该模型每轮消耗的积分倍数。',
      enableAll: '全选',
      disableAll: '全不选',
      modelName: '模型',
      creditsPerTurn: '积分倍率',
      context: '上下文',
      isDefault: '默认',
      saveModels: '保存模型设置',
      saving: '保存中…',
      selected: '已启用 {n} / {m}',
      noModels: '还没有探测到模型。先运行一次 CodeBuddy，或点刷新重新探测。',
      usageByModel: '按模型用量',
      recent: '最近调用',
      time: '时间',
      model: '模型',
      credits: '积分',
      tokenCount: 'Token',
      emptyUsage: '还没有用量记录。选 CodeBuddy 模型跑一轮后这里会自动累计。',
      connection: '连接',
      provider: 'Provider',
      connections: '常驻连接',
      dataDir: '数据目录',
      command: 'CLI 命令',
      modelsUpdated: '模型探测时间',
      none: '无',
      resetUsage: '清空用量账本',
      resetConfirm: '确定清空本插件的积分用量账本吗？设置与账号不受影响。',
      saved: '已保存',
      resetDone: '用量账本已清空',
      refreshModels: '重新探测模型',
      refreshCredits: '刷新积分',
      moveUp: '上移',
      moveDown: '下移',
      unknown: '未知',
      personal: '个人',
      enterprise: '企业',
      free: '免费',
      rateHint: '倍率来自 CodeBuddy 模型目录（product.json / ACP）。',
      toolFallback: 'CodeBuddy 工具调用',
      toolOutput: '输出',
      toolRunning: '执行中',
      toolDone: '完成',
      toolFailed: '失败',
      toolEmpty: '（这次调用没有返回内容）',
      toolOpen: '打开文件',
      toolKindRead: '读取',
      toolKindEdit: '修改',
      toolKindDelete: '删除',
      toolKindMove: '移动',
      toolKindSearch: '搜索',
      toolKindExecute: '执行',
      toolKindFetch: '抓取',
      toolKindThink: '思考',
      toolKindOther: '工具',
      toolNameRead: '读取',
      toolNameWrite: '写入',
      toolNameEdit: '修改',
      toolNameBash: '命令',
      toolNameSearch: '搜索',
      toolNameFetch: '抓取',
      toolNameTask: '任务',
      toolNameTodo: '待办',
      toolNameAgent: '智能体',
    }

    /** 英文文案（与中文键一一对应）。 */
    const EN = {
      title: 'CodeBuddy',
      subtitle: 'Credits left, daily check-in and model console',
      refreshing: 'Refreshing…',
      loading: 'Loading CodeBuddy data…',
      error: 'Failed to load',
      retry: 'Retry',
      remaining: 'Credits left',
      remainingHint: 'From your CodeBuddy credit packages',
      noAccount: 'No CodeBuddy sign-in found',
      loginHint: 'Credits and daily check-in are read from your local CodeBuddy CLI sign-in; the plugin never copies or uploads credentials.',
      refreshCredits: 'Refresh credits',
      account: 'Account & credits',
      user: 'Account',
      domain: 'Domain',
      authType: 'Sign-in',
      creditTotal: 'Available credits',
      creditPackages: 'Credit packages',
      noPackage: 'No active credit package',
      packageName: 'Package',
      packageRemain: 'Left',
      packageUsed: 'Used',
      packageExpire: 'Valid until',
      checkin: 'Daily credits',
      checkinClaim: 'Claim daily credits',
      checkinClaimed: 'Claimed today',
      checkinUnavailable: 'Not available',
      checkinDone: 'Claimed',
      checkinStreak: 'Streak {n} days',
      checkinToday: 'Got {n} credits today',
      checkinPending: 'Not claimed yet',
      checkinInactive: 'No check-in activity right now',
      calls: 'Calls',
      tokens: 'Tokens',
      today: 'Today',
      thisMonth: 'This month',
      total: 'Total',
      models: 'Models',
      modelsHint: 'Only checked models appear in the DSH model selector; the order here is the display order. The credit rate is the multiplier applied per turn.',
      enableAll: 'Enable all',
      disableAll: 'Disable all',
      modelName: 'Model',
      creditsPerTurn: 'Credit rate',
      context: 'Context',
      isDefault: 'Default',
      saveModels: 'Save model settings',
      saving: 'Saving…',
      selected: '{n} of {m} enabled',
      noModels: 'No models discovered yet. Run CodeBuddy once, or refresh to re-detect.',
      usageByModel: 'Usage by model',
      recent: 'Recent calls',
      time: 'Time',
      model: 'Model',
      credits: 'Credits',
      tokenCount: 'Tokens',
      emptyUsage: 'No usage recorded yet. Pick a CodeBuddy model and run a turn.',
      connection: 'Connection',
      provider: 'Provider',
      connections: 'Live connections',
      dataDir: 'Data directory',
      command: 'CLI command',
      modelsUpdated: 'Models detected at',
      none: 'None',
      resetUsage: 'Reset usage ledger',
      resetConfirm: 'Clear this plugin’s credit usage ledger? Settings and the account are untouched.',
      saved: 'Saved',
      resetDone: 'Usage ledger cleared',
      refreshModels: 'Re-detect models',
      refreshCredits: 'Refresh credits',
      moveUp: 'Move up',
      moveDown: 'Move down',
      unknown: 'Unknown',
      personal: 'Personal',
      enterprise: 'Enterprise',
      free: 'Free',
      rateHint: 'Rates come from the CodeBuddy model catalog (product.json / ACP).',
      toolFallback: 'CodeBuddy tool call',
      toolOutput: 'Output',
      toolRunning: 'Running',
      toolDone: 'Done',
      toolFailed: 'Failed',
      toolEmpty: '(this call returned no content)',
      toolOpen: 'Open file',
      toolKindRead: 'Read',
      toolKindEdit: 'Edit',
      toolKindDelete: 'Delete',
      toolKindMove: 'Move',
      toolKindSearch: 'Search',
      toolKindExecute: 'Run',
      toolKindFetch: 'Fetch',
      toolKindThink: 'Think',
      toolKindOther: 'Tool',
      toolNameRead: 'Read',
      toolNameWrite: 'Write',
      toolNameEdit: 'Edit',
      toolNameBash: 'Shell',
      toolNameSearch: 'Search',
      toolNameFetch: 'Fetch',
      toolNameTask: 'Task',
      toolNameTodo: 'Todo',
      toolNameAgent: 'Agent',
    }

    /** 页面样式：只用主题 token，跟随明暗主题。 */
    const CSS = `
.cbc-page{height:100%;overflow:auto;padding:28px 32px 48px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:13px;line-height:1.55}
.cbc-inner{max-width:1080px;margin:0 auto;display:flex;flex-direction:column;gap:18px}
.cbc-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.cbc-title{margin:0;font-size:20px;font-weight:600;letter-spacing:.2px}
.cbc-sub{margin-top:3px;color:var(--dsw-alias-label-secondary);font-size:12px}
.cbc-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.cbc-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer;transition:background .15s,border-color .15s}
.cbc-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.cbc-btn:disabled{opacity:.55;cursor:default}
.cbc-btn.primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground);font-weight:500}
.cbc-btn.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.cbc-btn.primary:disabled{background:var(--dsw-alias-button-primary-dimmed);color:var(--dsw-alias-label-primary);opacity:1}
.cbc-btn.ghost{background:transparent}
.cbc-btn.danger{color:var(--dsw-alias-state-error-primary)}
.cbc-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.cbc-kpi{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:6px}
.cbc-kpi-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.cbc-kpi-value{font-size:24px;font-weight:600;line-height:1.15;font-variant-numeric:tabular-nums}
.cbc-kpi-value small{font-size:12px;font-weight:400;color:var(--dsw-alias-label-secondary);margin-left:6px}
.cbc-kpi-note{font-size:11px;color:var(--dsw-alias-label-secondary)}
.cbc-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:18px 20px}
.cbc-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:12px;flex-wrap:wrap}
.cbc-card-title{font-size:14px;font-weight:600;margin:0}
.cbc-hint{margin:0 0 12px;color:var(--dsw-alias-label-secondary);font-size:12px}
.cbc-form{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap}
.cbc-field{display:flex;flex-direction:column;gap:5px;min-width:150px}
.cbc-field label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.cbc-input,.cbc-select{appearance:none;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:7px 10px;font-size:13px;min-width:150px;outline:none}
.cbc-input:focus,.cbc-select:focus{border-color:var(--dsw-alias-brand-primary)}
.cbc-table{width:100%;border-collapse:collapse;font-size:12.5px}
.cbc-table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-secondary);padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.cbc-table td{padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:middle}
.cbc-table tr:last-child td{border-bottom:none}
.cbc-model-name{display:flex;flex-direction:column;gap:1px}
.cbc-model-name b{font-weight:500}
.cbc-model-name code{font-size:11px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.cbc-num{font-variant-numeric:tabular-nums;white-space:nowrap}
.cbc-muted{color:var(--dsw-alias-label-secondary)}
.cbc-check{width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.cbc-order{display:flex;gap:4px}
.cbc-icon-btn{width:26px;height:26px;padding:0;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;background:transparent;border:1px solid transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.cbc-icon-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}
.cbc-icon-btn:disabled{opacity:.35;cursor:default}
.cbc-radio{accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.cbc-notice{border-radius:8px;padding:9px 12px;font-size:12px;border:1px solid transparent}
.cbc-notice.ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.cbc-notice.err{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.cbc-empty{color:var(--dsw-alias-label-secondary);font-size:12px;padding:10px 2px}
.cbc-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px}
.cbc-defs{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;font-size:12.5px;margin:0}
.cbc-defs dt{color:var(--dsw-alias-label-secondary)}
.cbc-defs dd{margin:0;word-break:break-all}
.cbc-scroll{max-height:320px;overflow:auto}
.cbc-rate{display:inline-block;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-size:11.5px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.cbc-rate.free{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.cbc-inline{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
@media (max-width:720px){.cbc-page{padding:18px 16px 32px}.cbc-kpis{grid-template-columns:1fr 1fr}}
`

    /**
     * 把应用内绝对路径解析成同源 URL（兼容带 base path 的部署）。
     * @param {string} path 以 `/` 开头的应用路径。
     * @returns {string} 解析后的 URL。
     */
    function resolveUrl(path) {
      try {
        const base = new URL(document.baseURI)
        if (!base.pathname.endsWith('/')) base.pathname += '/'
        return new URL(path.replace(/^\/+/, ''), base.href).href
      } catch {
        return path
      }
    }

    /**
     * 读取同源接口。
     * @param {string} path 接口路径。
     * @param {object} [body] POST 内容；省略时发 GET。
     * @returns {Promise<object>} data 字段。
     */
    async function callApi(path, body) {
      const url = resolveUrl(`${API}${path}`)
      const response = await fetch(url, body === undefined
        ? { cache: 'no-store' }
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-dsh-codebuddy-console': '1' },
            body: JSON.stringify(body),
          })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload === null || payload.ok !== true) {
        throw new Error(payload?.error ?? `HTTP ${response.status}`)
      }
      return payload.data
    }

    /**
     * 数字展示：整数不带小数，小数保留两位。
     * @param {number} value 数值。
     * @param {number} [digits] 小数位。
     * @returns {string} 文本。
     */
    function fmt(value, digits = 2) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      const text = value.toFixed(digits)
      return text.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
    }

    /**
     * 积分倍率：`0.34` → `×0.34`；0 显示「免费」。
     * @param {number} rate 倍率。
     * @param {Function} translate 翻译函数。
     * @returns {string} 文本。
     */
    function fmtRate(rate, translate) {
      if (typeof rate !== 'number' || !Number.isFinite(rate)) return '—'
      if (rate === 0) return translate('free')
      return `×${fmt(rate)}`
    }

    /**
     * Token 数量：过万用「万」表示。
     * @param {number} value 数量。
     * @returns {string} 文本。
     */
    function fmtTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      if (value >= 1000000) return `${fmt(value / 1000000, 1)}M`
      if (value >= 10000) return `${fmt(value / 10000, 1)}万`
      return String(Math.round(value))
    }

    /**
     * 上下文窗口：过万用「万」。
     * @param {number} value 数量。
     * @returns {string} 文本。
     */
    function fmtWindow(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—'
      if (value >= 1000000) return `${fmt(value / 1000000, 1)}M`
      if (value >= 1000) return `${fmt(value / 1000, 0)}K`
      return String(value)
    }

    /**
     * 时间戳格式化。
     * @param {number} at 毫秒时间戳。
     * @returns {string} 文本。
     */
    function fmtTime(at) {
      if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return '—'
      const date = new Date(at)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    /**
     * 侧栏图标（原创图形：六边形里的对话火花）。
     * @param {{ size?: number, active?: boolean }} props 图标属性。
     * @returns {object} React 元素。
     */
    function Icon({ size = 20, active = false }) {
      const edge = typeof size === 'number' ? size : 20
      return h('svg', {
        width: edge,
        height: edge,
        viewBox: '0 0 32 32',
        fill: 'none',
        'aria-hidden': true,
      },
      h('path', {
        d: 'M16 2.7 27.4 9.3v13.4L16 29.3 4.6 22.7V9.3Z',
        fill: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor',
        opacity: active ? 1 : 0.75,
      }),
      h('path', {
        d: 'M11.2 12.4h7.3a1.4 1.4 0 0 1 1.4 1.4v4.9a1.4 1.4 0 0 1-1.4 1.4h-3l-2.4 2v-2h-1.9a1.4 1.4 0 0 1-1.4-1.4v-4.9a1.4 1.4 0 0 1 1.4-1.4Z',
        fill: 'var(--dsw-alias-bg-base)',
      }),
      h('circle', { cx: 19.6, cy: 10.6, r: 1.9, fill: 'var(--dsw-alias-state-warn-primary)' }))
    }

    /**
     * 一行「标签 + 值」。
     * @param {{ label: string, value: object|string }} props 属性。
     * @returns {object} React 元素。
     */
    function Def({ label, value }) {
      return [h('dt', { key: 't' }, label), h('dd', { key: 'd' }, value)]
    }

    /**
     * 控制台页面。
     * @param {{ t: Function }} props 槽位属性（框架注入翻译函数）。
     * @returns {object} React 元素。
     */
    function ConsolePage({ t }) {
      const translate = typeof t === 'function' ? t : (key) => key
      const [state, setState] = React.useState({ status: 'loading', data: null, error: null })
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState(null)
      const [modelDraft, setModelDraft] = React.useState({ enabled: [], order: [], defaultModel: '' })

      const applyData = React.useCallback((data) => {
        setState({ status: 'ready', data, error: null })
        const models = Array.isArray(data?.models) ? data.models : []
        const settings = data?.settings?.models ?? {}
        const enabled = settings.enabled === null || settings.enabled === undefined
          ? models.map((model) => model.id)
          : models.filter((model) => settings.enabled.includes(model.id)).map((model) => model.id)
        const order = Array.isArray(settings.order) ? settings.order : []
        const rank = new Map(order.map((id, index) => [id, index]))
        enabled.sort((left, right) => (rank.get(left) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right) ?? Number.MAX_SAFE_INTEGER))
        setModelDraft({ enabled, order, defaultModel: settings.defaultModel ?? '' })
      }, [])

      const load = React.useCallback(async (quiet = false) => {
        if (!quiet) setState((previous) => ({ ...previous, status: previous.data === null ? 'loading' : 'refreshing' }))
        try {
          applyData(await callApi('/state'))
        } catch (error) {
          setState((previous) => ({ ...previous, status: 'error', error: error instanceof Error ? error.message : String(error) }))
        }
      }, [applyData])

      React.useEffect(() => { void load() }, [load])

      const action = React.useCallback(async (name, path, body, message) => {
        setBusy(name)
        setNotice(null)
        try {
          const data = await callApi(path, body)
          const next = data?.snapshot ?? data
          applyData(next)
          const text = typeof message === 'function' ? message(data) : message
          if (text !== undefined && text !== '') setNotice({ kind: 'ok', text })
          return data
        } catch (error) {
          setNotice({ kind: 'err', text: error instanceof Error ? error.message : String(error) })
          return undefined
        } finally {
          setBusy('')
        }
      }, [applyData])

      // 授权轮询与网页登录已下线：余额与签到直接读本机 CLI 登录态。
      const data = state.data
      const usage = data?.usage
      const billing = data?.billing ?? {}
      const credits = billing.credits ?? {}
      const checkin = billing.checkin ?? {}
      const models = Array.isArray(data?.models) ? data.models : []
      const modelIndex = new Map(models.map((model) => [model.id, model]))
      const drafts = modelDraft.enabled.map((id) => modelIndex.get(id)).filter(Boolean)
      const currentModel = data?.account?.currentModel
      const acpUser = data?.account?.users?.[0]
      const userName = billing.label || acpUser?.userName || acpUser?.userNickname || translate('unknown')
      const authType = acpUser?.authType

      const header = h('div', { className: 'cbc-head' },
        h('div', null,
          h('h1', { className: 'cbc-title' }, translate('title')),
          h('div', { className: 'cbc-sub' }, translate('subtitle'))),
        h('div', { className: 'cbc-actions' },
          h('button', {
            type: 'button',
            className: 'cbc-btn',
            disabled: busy !== '' || state.status === 'loading',
            onClick: () => { void action('credits', '/billing/refresh', {}, undefined) },
          }, busy === 'credits' ? translate('refreshing') : translate('refreshCredits')),
          h('button', {
            type: 'button',
            className: 'cbc-btn',
            disabled: busy !== '' || state.status === 'loading',
            onClick: () => { void action('refresh', '/refresh', {}, translate('saved')) },
          }, translate('refreshModels'))))

      if (state.status === 'loading') {
        return h('div', { className: 'cbc-page' }, h('style', null, CSS),
          h('div', { className: 'cbc-inner' }, header, h('div', { className: 'cbc-empty' }, translate('loading'))))
      }
      if (state.status === 'error' && data === null) {
        return h('div', { className: 'cbc-page' }, h('style', null, CSS),
          h('div', { className: 'cbc-inner' }, header,
            h('div', { className: 'cbc-notice err' }, `${translate('error')}：${state.error}`),
            h('div', null, h('button', { type: 'button', className: 'cbc-btn', onClick: () => { void load() } }, translate('retry')))))
      }

      const remainingNote = billing.available !== true
        ? (billing.reason || translate('noAccount'))
        : credits.ok === true
          ? `${translate('remainingHint')} · ${credits.activePackageCount ?? 0} ${translate('creditPackages')} · ${fmtTime(credits.at)}`
          : (credits.message || translate('error'))

      const kpiRemaining = h('div', { className: 'cbc-kpi' },
        h('div', { className: 'cbc-kpi-label' }, translate('remaining')),
        h('div', { className: 'cbc-kpi-value' }, credits.ok === true
          ? h('span', null, fmt(credits.total), h('small', null, translate('credits')))
          : h('span', { className: 'cbc-muted', style: { fontSize: '15px' } },
              billing.available === true ? translate('error') : translate('noAccount'))),
        h('div', { className: 'cbc-kpi-note' }, remainingNote))

      const kpis = h('section', { className: 'cbc-kpis' },
        kpiRemaining,
        h('div', { className: 'cbc-kpi' },
          h('div', { className: 'cbc-kpi-label' }, translate('today')),
          h('div', { className: 'cbc-kpi-value' }, fmt(usage?.today?.credits ?? 0), h('small', null, translate('credits'))),
          h('div', { className: 'cbc-kpi-note' }, `${fmt(usage?.today?.calls ?? 0, 0)} ${translate('calls')} · ${fmtTokens(usage?.today?.tokens ?? 0)} ${translate('tokens')}`)),
        h('div', { className: 'cbc-kpi' },
          h('div', { className: 'cbc-kpi-label' }, translate('thisMonth')),
          h('div', { className: 'cbc-kpi-value' }, fmt(usage?.month?.credits ?? 0), h('small', null, translate('credits'))),
          h('div', { className: 'cbc-kpi-note' }, `${fmt(usage?.month?.calls ?? 0, 0)} ${translate('calls')} · ${fmtTokens(usage?.month?.tokens ?? 0)} ${translate('tokens')}`)),
        h('div', { className: 'cbc-kpi' },
          h('div', { className: 'cbc-kpi-label' }, translate('total')),
          h('div', { className: 'cbc-kpi-value' }, fmt(usage?.total?.credits ?? 0), h('small', null, translate('credits'))),
          h('div', { className: 'cbc-kpi-note' }, `${fmt(usage?.total?.calls ?? 0, 0)} ${translate('calls')} · ${fmtTokens(usage?.total?.tokens ?? 0)} ${translate('tokens')}`)))

      const checkinLabel = checkin.checkedIn === true
        ? translate('checkinClaimed')
        : checkin.active === false
          ? translate('checkinUnavailable')
          : translate('checkinClaim')
      const checkinNote = checkin.checkedIn === true
        ? [checkin.todayCredit > 0 ? translate('checkinToday').replace('{n}', fmt(checkin.todayCredit)) : translate('checkinClaimed'), checkin.streakDays > 0 ? translate('checkinStreak').replace('{n}', String(checkin.streakDays)) : undefined].filter(Boolean).join(' · ')
        : checkin.active === false
          ? translate('checkinInactive')
          : checkin.message || translate('checkinPending')

      // 没读到登录态时的说明（不改任何上游状态，只提示去 CLI 登录）。
      const loginBlock = h('div', { className: 'cbc-inline' },
        h('span', { className: 'cbc-muted' }, billing.reason || translate('noAccount')),
        h('span', { className: 'cbc-muted' }, translate('loginHint')))

      const packageRows = Array.isArray(credits.packages) ? credits.packages.filter((item) => item.expired !== true) : []
      const packagesBlock = credits.ok !== true ? null : packageRows.length === 0
        ? h('div', { className: 'cbc-empty' }, translate('noPackage'))
        : h('table', { className: 'cbc-table' },
            h('thead', null, h('tr', null,
              h('th', null, translate('packageName')),
              h('th', null, translate('packageRemain')),
              h('th', null, translate('packageUsed')),
              h('th', null, translate('packageExpire')))),
            h('tbody', null, packageRows.map((item, index) => h('tr', { key: `${item.name}-${index}` },
              h('td', null, item.name),
              h('td', { className: 'cbc-num' }, `${fmt(item.remaining)} ${item.unit ?? ''}`.trim()),
              h('td', { className: 'cbc-num cbc-muted' }, fmt(item.used)),
              h('td', { className: 'cbc-num cbc-muted' }, item.expireAt > 0
                ? `${fmtTime(item.expireAt * 1000)}${item.expiresInDays === null ? '' : `（${item.expiresInDays} 天）`}`
                : '—')))))

      const accountCard = h('section', { className: 'cbc-card' },
        h('div', { className: 'cbc-card-head' },
          h('h2', { className: 'cbc-card-title' }, translate('account')),
          billing.available === true
            ? h('div', { className: 'cbc-actions' },
                h('button', {
                  type: 'button',
                  className: 'cbc-btn primary',
                  disabled: busy !== '' || checkin.checkedIn === true || checkin.active === false || checkin.ok === false,
                  onClick: () => { void action('checkin', '/billing/checkin', {}, (result) => result?.result?.message || translate('checkinDone')) },
                }, busy === 'checkin' ? translate('refreshing') : checkinLabel))
            : null),
        billing.available === true
          ? h('div', null,
              h('dl', { className: 'cbc-defs' },
                h(Def, { label: translate('user'), value: userName }),
                h(Def, { label: translate('authType'), value: authType === 'personal' ? translate('personal') : authType === 'enterprise' ? translate('enterprise') : (authType || translate('none')) }),
                h(Def, { label: translate('domain'), value: billing.domain || '—' }),
                h(Def, { label: translate('creditTotal'), value: `${credits.ok === true ? fmt(credits.total) : '—'} ${translate('credits')}` }),
                h(Def, { label: translate('checkin'), value: checkinNote })),
              h('div', { style: { marginTop: '14px' } },
                h('div', { className: 'cbc-hint', style: { marginBottom: '8px' } }, translate('creditPackages')),
                packagesBlock))
          : loginBlock)

      const modelRows = drafts.length > 0
        ? drafts.map((model, index) => h('tr', { key: model.id },
            h('td', null, h('input', {
              className: 'cbc-check',
              type: 'checkbox',
              checked: true,
              title: translate('disableAll'),
              onChange: () => setModelDraft((draft) => ({
                ...draft,
                enabled: draft.enabled.filter((id) => id !== model.id),
              })),
            })),
            h('td', null, h('div', { className: 'cbc-model-name' },
              h('b', null, model.name ?? model.id),
              h('code', null, model.id))),
            h('td', { className: 'cbc-num' }, h('span', {
              className: `cbc-rate${model.creditRate === 0 ? ' free' : ''}`,
            }, fmtRate(model.creditRate, translate))),
            h('td', { className: 'cbc-num cbc-muted' }, fmtWindow(model.contextWindow)),
            h('td', null, h('input', {
              className: 'cbc-radio',
              type: 'radio',
              name: 'cbc-default-model',
              checked: modelDraft.defaultModel === model.id,
              onChange: () => setModelDraft((draft) => ({ ...draft, defaultModel: model.id })),
            })),
            h('td', null, h('div', { className: 'cbc-order' },
              h('button', {
                type: 'button',
                className: 'cbc-icon-btn',
                title: translate('moveUp'),
                disabled: index === 0,
                onClick: () => setModelDraft((draft) => {
                  const next = draft.enabled.slice()
                  const [item] = next.splice(index, 1)
                  next.splice(index - 1, 0, item)
                  return { ...draft, enabled: next }
                }),
              }, '↑'),
              h('button', {
                type: 'button',
                className: 'cbc-icon-btn',
                title: translate('moveDown'),
                disabled: index === drafts.length - 1,
                onClick: () => setModelDraft((draft) => {
                  const next = draft.enabled.slice()
                  const [item] = next.splice(index, 1)
                  next.splice(index + 1, 0, item)
                  return { ...draft, enabled: next }
                }),
              }, '↓')))))
        : h('tr', null, h('td', { colSpan: 6, className: 'cbc-empty' }, translate('noModels')))

      const disabledModels = models.filter((model) => !modelDraft.enabled.includes(model.id))
      const modelCard = h('section', { className: 'cbc-card' },
        h('div', { className: 'cbc-card-head' },
          h('h2', { className: 'cbc-card-title' }, translate('models')),
          h('div', { className: 'cbc-actions' },
            h('span', { className: 'cbc-muted' }, translate('selected').replace('{n}', String(modelDraft.enabled.length)).replace('{m}', String(models.length))),
            h('button', {
              type: 'button',
              className: 'cbc-btn',
              disabled: busy !== '' || models.length === 0,
              onClick: () => setModelDraft((draft) => ({ ...draft, enabled: models.map((model) => model.id) })),
            }, translate('enableAll')),
            h('button', {
              type: 'button',
              className: 'cbc-btn',
              disabled: busy !== '' || modelDraft.enabled.length === 0,
              onClick: () => setModelDraft((draft) => ({ ...draft, enabled: [] })),
            }, translate('disableAll')),
            h('button', {
              type: 'button',
              className: 'cbc-btn primary',
              disabled: busy !== '',
              onClick: () => {
                const allEnabled = modelDraft.enabled.length === models.length
                const order = modelDraft.enabled.concat(
                  models.filter((model) => !modelDraft.enabled.includes(model.id)).map((model) => model.id))
                void action('models', '/settings', {
                  models: {
                    enabled: allEnabled ? null : modelDraft.enabled,
                    order,
                    defaultModel: modelDraft.defaultModel === '' ? null : modelDraft.defaultModel,
                  },
                }, translate('saved'))
              },
            }, busy === 'models' ? translate('saving') : translate('saveModels')))),
        h('p', { className: 'cbc-hint' }, translate('modelsHint')),
        h('table', { className: 'cbc-table' },
          h('thead', null, h('tr', null,
            h('th', { style: { width: '44px' } }, '✓'),
            h('th', null, translate('modelName')),
            h('th', null, translate('creditsPerTurn')),
            h('th', null, translate('context')),
            h('th', { style: { width: '64px' } }, translate('isDefault')),
            h('th', { style: { width: '84px' } }, ''))),
          h('tbody', null, modelRows)),
        h('div', { className: 'cbc-hint', style: { marginTop: '10px', marginBottom: 0 } }, translate('rateHint')),
        disabledModels.length > 0
          ? h('div', { style: { marginTop: '12px' } },
              h('div', { className: 'cbc-hint' }, translate('disableAll')),
              h('div', { className: 'cbc-actions', style: { justifyContent: 'flex-start' } },
                disabledModels.map((model) => h('button', {
                  key: model.id,
                  type: 'button',
                  className: 'cbc-btn ghost',
                  onClick: () => setModelDraft((draft) => ({ ...draft, enabled: [...draft.enabled, model.id] })),
                }, `+ ${model.name ?? model.id}`))))
          : null)

      const byModelRows = Object.entries(usage?.byModel ?? {})
        .sort((left, right) => (right[1].credits ?? 0) - (left[1].credits ?? 0))
      const usageCard = h('section', { className: 'cbc-card' },
        h('div', { className: 'cbc-card-head' }, h('h2', { className: 'cbc-card-title' }, translate('usageByModel'))),
        byModelRows.length === 0
          ? h('div', { className: 'cbc-empty' }, translate('emptyUsage'))
          : h('table', { className: 'cbc-table' },
              h('thead', null, h('tr', null,
                h('th', null, translate('model')),
                h('th', null, translate('creditsPerTurn')),
                h('th', null, `${translate('today')} ${translate('credits')}`),
                h('th', null, `${translate('total')} ${translate('credits')}`),
                h('th', null, translate('calls')),
                h('th', null, translate('tokens')))),
              h('tbody', null, byModelRows.map(([id, value]) => h('tr', { key: id },
                h('td', null, h('div', { className: 'cbc-model-name' },
                  h('b', null, modelIndex.get(id)?.name ?? id),
                  h('code', null, id))),
                h('td', { className: 'cbc-num' }, fmtRate(modelIndex.get(id)?.creditRate, translate)),
                h('td', { className: 'cbc-num' }, fmt(value.todayCredits ?? 0)),
                h('td', { className: 'cbc-num' }, fmt(value.credits ?? 0)),
                h('td', { className: 'cbc-num cbc-muted' }, fmt(value.calls ?? 0, 0)),
                h('td', { className: 'cbc-num cbc-muted' }, fmtTokens(value.tokens ?? 0)))))))

      const recent = Array.isArray(usage?.recent) ? usage.recent : []
      const recentCard = h('section', { className: 'cbc-card' },
        h('div', { className: 'cbc-card-head' },
          h('h2', { className: 'cbc-card-title' }, translate('recent')),
          h('button', {
            type: 'button',
            className: 'cbc-btn danger',
            disabled: busy !== '',
            onClick: () => {
              if (!window.confirm(translate('resetConfirm'))) return
              void action('reset', '/reset', {}, translate('resetDone'))
            },
          }, translate('resetUsage'))),
        recent.length === 0
          ? h('div', { className: 'cbc-empty' }, translate('emptyUsage'))
          : h('div', { className: 'cbc-scroll' }, h('table', { className: 'cbc-table' },
              h('thead', null, h('tr', null,
                h('th', null, translate('time')),
                h('th', null, translate('model')),
                h('th', null, translate('credits')),
                h('th', null, translate('tokenCount')))),
              h('tbody', null, recent.map((item, index) => h('tr', { key: `${item.at}-${index}` },
                h('td', { className: 'cbc-num cbc-muted' }, fmtTime(item.at)),
                h('td', null, modelIndex.get(item.model)?.name ?? item.model ?? translate('unknown')),
                h('td', { className: 'cbc-num' }, fmt(item.credits ?? 0)),
                h('td', { className: 'cbc-num cbc-muted' }, fmtTokens(item.tokens ?? 0))))))))

      const connectionCard = h('section', { className: 'cbc-card' },
        h('div', { className: 'cbc-card-head' }, h('h2', { className: 'cbc-card-title' }, translate('connection'))),
        h('dl', { className: 'cbc-defs' },
          h(Def, { label: translate('provider'), value: `${data?.account?.provider ?? 'codebuddy'} · ${data?.account?.displayName ?? 'CodeBuddy'}` }),
          h(Def, { label: translate('connections'), value: String(data?.account?.connections ?? 0) }),
          h(Def, { label: translate('modelsUpdated'), value: fmtTime(data?.account?.modelsAt) }),
          h(Def, { label: translate('command'), value: h('code', null, data?.account?.command ?? 'codebuddy') }),
          h(Def, { label: translate('dataDir'), value: h('code', null, data?.config?.dataDir ?? '—') }),
          currentModel === undefined ? null : h(Def, { label: translate('isDefault'), value: currentModel })))

      return h('div', { className: 'cbc-page' },
        h('style', null, CSS),
        h('div', { className: 'cbc-inner' },
          header,
          notice === null ? null : h('div', { className: `cbc-notice ${notice.kind}` }, notice.text),
          state.status === 'error' ? h('div', { className: 'cbc-notice err' }, `${translate('error')}：${state.error}`) : null,
          kpis,
          accountCard,
          modelCard,
          h('div', { className: 'cbc-grid2' }, usageCard, connectionCard),
          recentCard))
    }

    /**
     * CodeBuddy 工具调用卡片。
     *
     * 适配器把 CodeBuddy 的 `tool_call` 转成 DSH 原生的 tool-call 块后，DSH 会用
     * `codebuddy_tool` 执行一次「回放」，于是这里同时拿到调用参数（title/kind/path）
     * 与真实工具输出（content）。卡片刻意不用 hook：展开态交给 `<details>`，
     * 这样在流式、重放、无状态渲染三种路径下都不会出问题。
     *
     * 版式要点（对应「卡片长得一样、堆在一起」的问题）：
     *
     * - **左侧色条 + 彩色徽章**按工具家族区分（读取/命令/修改/搜索/抓取/任务…），
     *   一眼能看出这次是 Bash 还是 Edit；
     * - 主行只放「真实工具名 + 主语」，路径可点、命令用等宽字体，标题不再重复整句；
     * - 输出默认折叠，卡片之间留出间距，多张卡片不会糊成一坨。
     *
     * @param {object} props 工具视图 props（phase / block / cwd / openFile / t）。
     * @returns {object} React 元素。
     */
    function ToolRow(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const phase = typeof props.phase === 'string' ? props.phase : 'result'
      const block = props.block ?? {}
      const meta = block.meta ?? {}

      /** 取参数 JSON：result 阶段在 block.call.argsRaw，运行中在 block.argsRaw。 */
      const argsRaw = phase === 'result' ? (block.call?.argsRaw ?? '') : (block.argsRaw ?? '')
      let args = {}
      try {
        const parsed = argsRaw === '' ? undefined : JSON.parse(argsRaw)
        if (parsed !== null && typeof parsed === 'object') args = parsed
      } catch {
        args = {}
      }

      const kind = typeof meta.kind === 'string' ? meta.kind
        : typeof args.kind === 'string' ? args.kind : 'other'
      const title = typeof args.title === 'string' && args.title !== '' ? args.title
        : typeof meta.title === 'string' && meta.title !== '' ? meta.title
          : t('toolFallback')

      // 真实工具名（`Read` / `Bash` / `Edit`…）—— 决定家族、配色与徽章文案。
      const toolName = typeof args.tool === 'string' && args.tool !== '' ? args.tool : ''
      const familyId = toolFamilyOf(toolName, kind)
      const family = TOOL_FAMILIES[familyId] ?? TOOL_FAMILIES.other
      const familyLabel = t(family.key)

      // 主语：标题去掉工具名前缀（`Read a.txt` → `a.txt`）。工具名已经由徽章表达，不重复。
      const stripped = title.replace(/^`+|`+$/g, '').trim()
      const subject = toolName !== '' && stripped.toLowerCase().startsWith(toolName.toLowerCase())
        ? stripped.slice(toolName.length).replace(/^[\s:：]+/, '').trim()
        : stripped
      const command = typeof args.command === 'string' && args.command !== '' ? args.command : undefined
      const summary = subject !== '' ? subject : (command ?? title)

      // 记录快照里的真实状态：settle 模式下卡片到手就已经是终态。
      const recordStatus = typeof meta.status === 'string' ? meta.status
        : typeof args.status === 'string' ? args.status : undefined
      const failed = recordStatus === 'failed' || (phase === 'result' && block.isError === true)
      const done = phase === 'result' || recordStatus === 'completed' || recordStatus === 'failed'
      const statusText = failed ? t('toolFailed') : done ? t('toolDone') : t('toolRunning')
      const statusTone = failed ? 'rgba(220,80,80,.16)' : done ? 'rgba(16,150,90,.14)' : family.bg
      const statusColor = failed ? '#c33' : done ? '#0a7f52' : family.color

      const content = phase === 'result' && Array.isArray(block.content)
        ? block.content.map((item) => (typeof item?.text === 'string' ? item.text : '')).filter((text) => text !== '').join('\n')
        : ''

      const rawPath = typeof meta.path === 'string' && meta.path !== '' ? meta.path
        : typeof args.path === 'string' && args.path !== '' ? args.path : undefined
      const cwd = typeof props.cwd === 'string' ? props.cwd : ''
      const shownPath = rawPath !== undefined && cwd !== '' && rawPath.toLowerCase().startsWith(cwd.toLowerCase())
        ? rawPath.slice(cwd.length).replace(/^[\\/]/, '')
        : rawPath

      const pill = (background, color) => ({
        display: 'inline-block', padding: '0 6px', borderRadius: 4, fontSize: 11, lineHeight: '18px',
        background, color, flex: 'none',
      })

      return h('div', {
        style: {
          display: 'flex', flexDirection: 'column', gap: 6,
          margin: '4px 0',
          padding: '8px 10px 8px 12px', borderRadius: 8,
          border: `1px solid ${failed ? 'rgba(220,80,80,.45)' : 'var(--dsw-alias-border-subtle, rgba(0,0,0,.12))'}`,
          borderLeft: `3px solid ${family.color}`,
          background: 'var(--dsw-alias-bg-elevated, rgba(0,0,0,.02))',
          fontSize: 12.5,
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
          h('span', { style: pill(family.bg, family.color) }, familyLabel),
          toolName === '' || toolName.toLowerCase() === familyLabel.toLowerCase() ? null : h('span', {
            style: { color: 'var(--dsw-alias-label-secondary, #888)', fontSize: 11.5, flex: 'none' },
          }, toolName),
          h(familyId === 'bash' ? 'code' : 'span', {
            title,
            style: {
              fontWeight: 600, minWidth: 0,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              fontFamily: familyId === 'bash' ? 'ui-monospace, SFMono-Regular, Consolas, monospace' : undefined,
            },
          }, summary === '' ? t('toolFallback') : summary),
          shownPath === undefined || subject.includes(shownPath) ? null : h('code', {
            title: rawPath,
            onClick: typeof props.openFile === 'function' ? () => props.openFile(rawPath) : undefined,
            style: {
              color: 'var(--dsw-alias-label-secondary, #666)', fontSize: 11.5, cursor: 'pointer',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 420, flex: 'none',
            },
          }, shownPath),
          h('span', { style: { marginLeft: 'auto', ...pill(statusTone, statusColor) } }, statusText)),
        content === ''
          ? (phase === 'result' ? h('div', { style: { color: 'var(--dsw-alias-label-secondary, #888)', fontStyle: 'italic' } }, t('toolEmpty')) : null)
          : h('details', null,
              h('summary', { style: { cursor: 'pointer', color: 'var(--dsw-alias-label-secondary, #666)', fontSize: 12 } },
                `${t('toolOutput')}（${content.length} 字符）`),
              h('pre', {
                style: {
                  margin: '6px 0 0', padding: 8, maxHeight: 360, overflow: 'auto',
                  borderRadius: 6, background: 'var(--dsw-alias-bg-base, #fff)', fontSize: 12,
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                },
              }, content)))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }))
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: 'codebuddy', locale: NS, inject: () => ({ t }) },
          ConsolePage))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: 'codebuddy', order: 25, label: () => t('title'), locale: NS },
          Icon))
        // CodeBuddy 的工具调用卡片：按工具名接管通用行。
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
          { name: 'tool.call.toolview', key: TOOL_NAME, locale: NS },
          ToolRow))
      },
    }
  },
})

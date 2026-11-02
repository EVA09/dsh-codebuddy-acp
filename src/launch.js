/**
 * 解析「如何启动 CodeBuddy」。
 *
 * 两个诉求：
 * 1. Windows 上 `codebuddy` 是 npm 生成的 .cmd 外壳，直接 spawn 不走 shell 会失败；
 *    通过 cmd.exe 包一层又能可靠地收发 stdio，但会把进程树变成两层，取消/退出更难控。
 *    因此优先定位 npm 全局包里的 JS 入口，用 node 直接执行。
 * 2. 桌面端 Host 跑在 Electron 里，`process.execPath` 是应用本体而不是 node，
 *    所以 node 可执行文件必须另外探测。
 *
 * @module src/launch.js
 */

import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

import { CODEBUDDY_BIN, CODEBUDDY_PACKAGE } from './config.js'

/**
 * 枚举可能的全局 node_modules 根目录。
 * @returns {string[]} 去重后的候选根目录。
 */
function candidateModuleRoots() {
  const roots = []
  const appData = process.env.APPDATA
  if (typeof appData === 'string' && appData.length > 0) {
    roots.push(join(appData, 'npm', 'node_modules'))
  }
  const execDir = dirname(process.execPath)
  roots.push(join(execDir, 'node_modules'))
  roots.push(join(execDir, '..', 'lib', 'node_modules'))
  let dir = process.cwd()
  for (let depth = 0; depth < 6; depth += 1) {
    const parent = dirname(dir)
    if (parent === dir) break
    roots.push(join(dir, 'node_modules'))
    dir = parent
  }
  return [...new Set(roots)]
}

/**
 * 找到 CodeBuddy 的 JS 入口（package.json 里 bin 指向的文件）。
 * @returns {string | undefined} 入口文件路径。
 */
export function findCodeBuddyEntry() {
  for (const root of candidateModuleRoots()) {
    const entry = join(root, CODEBUDDY_PACKAGE, 'bin', CODEBUDDY_BIN)
    if (existsSync(entry)) return entry
  }
  return undefined
}

/**
 * 探测 node 可执行文件。
 *
 * Electron 主进程里 `process.execPath` 指向应用本体，直接拿来跑脚本会启动第二个应用实例，
 * 因此只有可执行文件名像 node 时才接受它。
 *
 * @param {string | undefined} configured 配置里显式指定的 node 路径。
 * @returns {string} node 可执行文件路径（可能只是 PATH 里的裸命令）。
 */
export function resolveNodeBinary(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()

  const execName = process.execPath.split(/[\\/]/).pop() ?? ''
  if (/^node(\.exe)?$/i.test(execName)) return process.execPath

  const probe = process.platform === 'win32' ? 'where.exe' : 'which'
  for (const name of ['node', 'nodejs']) {
    try {
      const output = execFileSync(probe, [name], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
      const first = output.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0)
      if (first !== undefined && existsSync(first)) return first
    } catch {
      // 换下一个候选名。
    }
  }
  return 'node'
}

/**
 * 把配置解析成实际可执行的 argv。
 *
 * @param {{ command: string, nodePath?: string }} config 生效配置。
 * @returns {{ argv: string[], shell: boolean, entry?: string, node?: string, note: string }}
 *   argv 前缀（不含 ACP 参数）、是否用 shell 包一层、以及诊断信息。
 */
export function resolveLaunch(config) {
  const raw = typeof config.command === 'string' && config.command.trim() !== ''
    ? config.command.trim()
    : CODEBUDDY_BIN
  const node = resolveNodeBinary(config.nodePath)

  if (isAbsolute(raw)) {
    if (!existsSync(raw)) {
      throw new Error(`dsh-codebuddy-acp: command 指向的文件不存在：${raw}`)
    }
    if (/\.(?:c|m)?js$/i.test(raw)) {
      return { argv: [node, raw], shell: false, node, note: `绝对路径 JS 入口（node ${node}）` }
    }
    try {
      const info = statSync(raw)
      if (info.isDirectory()) throw new Error(`dsh-codebuddy-acp: command 指向的是目录：${raw}`)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('dsh-codebuddy-acp:')) throw error
    }
    return { argv: [raw], shell: false, note: '绝对路径可执行文件' }
  }

  if (process.platform !== 'win32') {
    return { argv: [raw], shell: false, note: 'PATH 中的命令' }
  }

  const entry = findCodeBuddyEntry()
  if (entry !== undefined) {
    return { argv: [node, entry], shell: false, entry, node, note: `npm 全局包 JS 入口（node ${node}）` }
  }
  return {
    argv: [process.env.ComSpec ?? 'cmd.exe', '/d', '/s', '/c', raw],
    shell: false,
    note: '未能定位 JS 入口，改用 cmd.exe 外壳',
  }
}

/**
 * 组装子进程环境变量。
 *
 * CodeBuddy 的登录态在 `~/.codebuddy`，不需要本插件传凭据；这里只覆盖用户显式配置的部分。
 * 想用 API Key 通道时，把 `CODEBUDDY_API_KEY`（中国版还要 `CODEBUDDY_INTERNET_ENVIRONMENT=internal`）
 * 写进配置的 `env` 即可，插件不读取、不落盘任何凭据。
 *
 * @param {Record<string, string>} extra 用户配置的额外环境变量。
 * @returns {Record<string, string>} 要覆盖到 process.env 上的键值。
 */
export function buildEnv(extra) {
  return { ...extra }
}

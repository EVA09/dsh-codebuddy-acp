/**
 * 把 DSH 消息里的图片块翻译成 ACP `session/prompt` 的 image 内容块。
 *
 * 为什么需要这个模块：DSH 的用户消息里图片是 `{ type:'image', attachment: ImageAttachmentRef }`，
 * `attachment` 只是**引用**（同一份字节只会存一次），真正的 base64 要从 `ctx.attachments`
 * 读出来。而 ACP 的 prompt 内容块是 `{ type:'image', data:<canonical base64>, mimeType }`。
 * 旧实现把图片压成文本占位符 `[图片附件：name]`，等于**从来没把图发给 CodeBuddy**。
 *
 * 本模块只做「纯计算」：收集引用、决定这一次投递哪些、拼提示词里的图片标号。
 * 读字节与发请求分别由宿主桥（`ctx.attachments`）和适配器负责，因此这些函数可以离线单测。
 *
 * @module src/image-input.js
 */

/**
 * CodeBuddy / ACP 接受的位图类型，与 DSH 的 `ImageMediaType` 完全一致。
 * 不在这个集合里的图片**没有协议通路**，只能退回文本占位符。
 */
export const IMAGE_MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** 省略图片时给模型看的固定说明（对应 DSH 的 `image/offload` 语义）。 */
export const OFFLOADED_IMAGE_TEXT = '[图片已省略：为控制请求体积被压缩流程移除；如仍需看这张图，请让用户重新发送]'

/** 重放历史时图片的投递策略。 */
export const REPLAY_IMAGE_MODES = Object.freeze(['latest', 'all', 'none'])

/**
 * 判断一个内容块是不是「可投递的图片」，是则返回它的引用。
 *
 * 以下情况返回 `undefined`（调用方据此退回文本占位符）：
 * - 不是 image 块；
 * - 已被压缩流程省略（`offloaded === true`）——这一段历史里根本没有字节可读；
 * - 引用字段残缺（没有 attachmentId / mediaType 不在支持列表）。
 *
 * @param {object} block 消息内容块。
 * @returns {{ attachmentId: string, mediaType: string, bytes?: number, width?: number, height?: number, name?: string } | undefined} 图片引用。
 */
export function imageRefOf(block) {
  if (block === null || typeof block !== 'object' || block.type !== 'image') return undefined
  if (block.offloaded === true) return undefined
  const ref = block.attachment
  if (ref === null || typeof ref !== 'object') return undefined
  if (typeof ref.attachmentId !== 'string' || ref.attachmentId.length === 0) return undefined
  if (!IMAGE_MEDIA_TYPES.includes(ref.mediaType)) return undefined
  return ref
}

/**
 * 按**渲染顺序**收集一批消息里的图片引用。
 *
 * 返回的 `refs` 顺序就是提示词里 `[图片 N：…]` 的编号顺序，也是 prompt 里
 * image 内容块的顺序；`groups[messageIndex]` 给出第几条消息贡献了哪几个下标，
 * 重放历史时据此只投递最后一条用户消息的图片（`replayImages: 'latest'`）。
 *
 * @param {readonly object[] | undefined} messages 待投喂消息。
 * @returns {{ refs: object[], groups: number[][] }} 引用与按消息分组的下标。
 */
export function collectImageRefs(messages) {
  const refs = []
  const groups = []
  const list = Array.isArray(messages) ? messages : []
  for (let index = 0; index < list.length; index += 1) {
    const offsets = []
    // 工具结果消息**不投喂**（CodeBuddy 自己执行过那些工具，见 `renderMessages`），
    // 所以它们的图片也不能占编号，否则正文标号与实际投递顺序会错位。
    if (list[index]?.role === 'tool') {
      groups.push(offsets)
      continue
    }
    const content = Array.isArray(list[index]?.content) ? list[index].content : []
    for (const block of content) {
      const ref = imageRefOf(block)
      if (ref === undefined) continue
      offsets.push(refs.length)
      refs.push(ref)
    }
    groups.push(offsets)
  }
  return { refs, groups }
}

/**
 * 找出最后一条用户消息贡献的图片下标。
 * @param {readonly object[]} messages 待投喂消息。
 * @param {number[][]} groups {@link collectImageRefs} 的分组下标。
 * @returns {number[]} 需要投递的 `refs` 下标。
 */
export function latestUserImageIndexes(messages, groups) {
  const list = Array.isArray(messages) ? messages : []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.role !== 'user') continue
    return groups[index] ?? []
  }
  // 没有用户消息（例如压缩后的纯助手历史）：退回最后一条带图的消息。
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    if ((groups[index] ?? []).length > 0) return groups[index]
  }
  return []
}

/**
 * 决定这一轮**实际投递**哪些图片下标。
 *
 * - 增量投喂（正常一轮）：新消息里的图片全部投递；
 * - 重放完整历史：按 `mode` 决定——`latest`（默认，只投最后一条用户消息的图，
 *   避免每次重开会话都把历史截图重发一遍）、`all`、`none`。
 *
 * @param {object} options 参数。
 * @param {readonly object[]} options.messages 本轮要投喂的消息。
 * @param {number[][]} options.groups 分组下标。
 * @param {boolean} options.replay 是否在重放完整历史。
 * @param {string} options.mode `replayImages` 配置值（仅 `replay` 为真时生效）。
 * @returns {number[]} 需要投递的 `refs` 下标（升序）。
 */
export function selectImageIndexes({ messages, groups, replay, mode }) {
  const total = groups.reduce((sum, offsets) => sum + offsets.length, 0)
  if (total === 0) return []
  if (!replay) return groups.flat()
  if (mode === 'none') return []
  if (mode === 'all') return groups.flat()
  return latestUserImageIndexes(messages, groups)
}

/**
 * 拼提示词里的图片标号。
 *
 * 编号与 prompt 里 image 内容块的顺序一一对应；`note` 非空表示这张图**没能**
 * 真的发出去，要在这里说清楚原因，否则模型会以为附件就在眼前。
 *
 * @param {object | undefined} ref 图片引用。
 * @param {number | undefined} index 从 1 开始的编号（未收集时为 undefined）。
 * @param {string | undefined} note 未投递的原因。
 * @returns {string} 占位文本。
 */
export function imageMarker(ref, index, note) {
  const label = index === undefined ? '图片附件' : `图片 ${index}`
  const name = typeof ref?.name === 'string' && ref.name.trim() !== '' ? `：${ref.name.trim()}` : ''
  const suffix = typeof note === 'string' && note !== '' ? `（${note}）` : ''
  return `[${label}${name}${suffix}]`
}

/**
 * 一个图片引用是否还有字节可读（用于决定「要不要去读」）。
 * @param {object | undefined} ref 图片引用。
 * @returns {boolean} 是否可投递。
 */
export function isDeliverableRef(ref) {
  return ref !== undefined && typeof ref.attachmentId === 'string' && IMAGE_MEDIA_TYPES.includes(ref.mediaType)
}

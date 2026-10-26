/**
 * cortico-world-proactive — a Coopanion World that lets the pet want to talk to its person.
 *
 * It does not ask the model to reach out. It watches how long the conversation has been quiet,
 * rolls a chance that grows with the quiet, and when the roll succeeds it pushes one *inner
 * thought* into the conversation. Whether that thought becomes a message is the model's call.
 *
 * A chat with the person — their message, or a line the pet actually says — resets the clock, so
 * the chance falls back to its initial value.
 */
import fs from 'node:fs'
import path from 'node:path'

const WORLD_ID = 'proactive'
const TICK_MS = 60_000
const PENDING_MS = 15 * 60_000
/** Tool steps that mean the pet actually reached out, whatever channel it used. */
const SPEAK_STEPS = new Set(['pet_say', 'pet_ask', 'qq_send', 'tg_send'])
const DEFAULT_OWNER = '主人'

const DEFAULT_LEVELS = [
  {
    afterMinutes: 30,
    thoughts: [
      '已经有一阵没和{owner}说话了。要不要凑过去看看，还是先别打扰？',
      '不知道{owner}在忙什么，好像挺久没聊了……要不要冒个泡？',
    ],
  },
  {
    afterMinutes: 60,
    thoughts: [
      '一个多小时没听见{owner}的声音了。ta 是在专心做事，还是把我忘了？',
      '安静得有点久了。要不要去蹭一下{owner}，万一 ta 正需要人说句话呢。',
    ],
  },
  {
    afterMinutes: 120,
    thoughts: [
      '好久没和{owner}聊天了。我是不是该主动一点？可要是打扰到 ta，就不好了。',
      '屏幕那边一直没动静。有点想找{owner}说说话，又怕自己太黏人。',
    ],
  },
  {
    afterMinutes: 240,
    thoughts: [
      '已经很久很久没和{owner}说话了。再不去说一句，我怕 ta 都要把我忘了。',
      '这份安静压得我有点难受。哪怕只蹭{owner}一下，说一个字也好。',
    ],
  },
]

/** The chance, in percent, for a quiet of `idleMinutes`. 0 while still under the first threshold. */
export function chanceFor(cfg, idleMinutes) {
  const start = number(cfg.idleMinutes, 30)
  if (idleMinutes < start) return 0
  const step = Math.max(1, number(cfg.stepMinutes, 10))
  const initial = number(cfg.initialChance, 10)
  const grow = number(cfg.stepChance, 10)
  const cap = number(cfg.maxChance, 80)
  const steps = Math.floor((idleMinutes - start) / step)
  return Math.min(cap, initial + steps * grow)
}

/** Which level of the thought applies at this quiet; the last level whose threshold has passed. */
export function levelFor(levels, idleMinutes) {
  let chosen = levels[0]
  for (const level of levels) {
    if (idleMinutes >= number(level.afterMinutes, Infinity)) chosen = level
  }
  return chosen
}

/** One thought of the level, `{owner}` filled in; the two options are picked at random. */
export function thoughtFor(levels, idleMinutes, ownerName, random = Math.random) {
  const level = levelFor(levels, idleMinutes)
  const options = Array.isArray(level?.thoughts) ? level.thoughts.filter((t) => typeof t === 'string' && t.trim()) : []
  if (!options.length) return ''
  const picked = options[Math.floor(random() * options.length) % options.length]
  return picked.replaceAll('{owner}', ownerName)
}

/** Parses the optional JSON override; bad input falls back to the built-in levels. */
export function parseLevels(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return DEFAULT_LEVELS
  try {
    const parsed = JSON.parse(text)
    const levels = (Array.isArray(parsed) ? parsed : [])
      .filter((level) => level && Number.isFinite(Number(level.afterMinutes)))
      .map((level) => ({
        afterMinutes: Number(level.afterMinutes),
        thoughts: (Array.isArray(level.thoughts) ? level.thoughts : []).filter((t) => typeof t === 'string'),
      }))
      .filter((level) => level.thoughts.length)
      .sort((a, b) => a.afterMinutes - b.afterMinutes)
    return levels.length ? levels : DEFAULT_LEVELS
  } catch {
    return DEFAULT_LEVELS
  }
}

/** "23:00-07:00, 12:00-13:00" → minute ranges; crossing midnight is allowed. */
export function parseRestWindows(raw) {
  return String(raw ?? '')
    .split(/[,;；、\n]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(item)
      if (!m) return null
      const start = Number(m[1]) * 60 + Number(m[2])
      const end = Number(m[3]) * 60 + Number(m[4])
      return start === end ? null : { start, end }
    })
    .filter(Boolean)
}

export function inRestWindow(windows, date) {
  const minutes = date.getHours() * 60 + date.getMinutes()
  return windows.some(({ start, end }) =>
    start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end,
  )
}
function number(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function asText(value) {
  return typeof value === 'string' ? value : ''
}

export class ProactiveWorld {
  constructor(options = {}) {
    this.id = WORLD_ID
    this.ctx = options.ctx ?? {}
    this.cfg = options.cfg ?? {}
    this.now = options.now ?? (() => Date.now())
    this.random = options.random ?? Math.random
    this.host = null
    this.timer = null
    this.cursor = 0
    this.lastChatAt = 0
    this.lastBucket = -1
    this.pendingThoughtAt = 0
    this.graceSpokeAt = 0
    this.graceFrom = 0
    this.unanswered = 0
    this.sleeping = false
    this.thrown = 0
    this.stateFile = typeof this.ctx?.dataDir === 'string' && this.ctx.dataDir
      ? path.join(this.ctx.dataDir, 'proactive-state.json')
      : null
  }

  get ownerName() {
    return asText(this.cfg.ownerName).trim() || DEFAULT_OWNER
  }

  get levels() {
    return parseLevels(this.cfg.levelsJson)
  }

  get restWindows() {
    return parseRestWindows(this.cfg.restWindows)
  }

  get graceMs() {
    return Math.max(1, number(this.cfg.graceMinutes, 10)) * 60_000
  }

  get chance() {
    return chanceFor(this.cfg, this.idleMinutes())
  }

  idleMinutes() {
    return Math.max(0, (this.now() - this.lastChatAt) / 60_000)
  }

  load() {
    if (!this.stateFile) return
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))
      this.lastChatAt = Number(parsed?.lastChatAt) || 0
      this.lastBucket = Number.isFinite(parsed?.lastBucket) ? parsed.lastBucket : -1
      this.pendingThoughtAt = Number(parsed?.pendingThoughtAt) || 0
      this.graceSpokeAt = Number(parsed?.graceSpokeAt) || 0
      this.graceFrom = Number(parsed?.graceFrom) || 0
      this.unanswered = Number(parsed?.unanswered) || 0
    } catch {
      // first run
    }
  }

  save() {
    if (!this.stateFile) return
    try {
      fs.writeFileSync(
        this.stateFile,
        `${JSON.stringify(
          {
            lastChatAt: this.lastChatAt,
            lastBucket: this.lastBucket,
            pendingThoughtAt: this.pendingThoughtAt,
            graceSpokeAt: this.graceSpokeAt,
            graceFrom: this.graceFrom,
            unanswered: this.unanswered,
          },
          null,
          2,
        )}\n`,
        'utf8',
      )
    } catch {
      // state stays in memory for this run
    }
  }

  async start(host) {
    this.host = host
    this.load()
    if (!this.lastChatAt) this.lastChatAt = this.now()
    this.cursor = host.store.latestCursor()
    host.log.info(
      `proactive: 已启动，主人称呼=${this.ownerName}，上次聊天 ${new Date(this.lastChatAt).toISOString()}`,
    )
    this.timer = setInterval(() => {
      void this.tick()
    }, TICK_MS)
    this.timer.unref?.()
  }

  async stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.host = null
  }

  get enabled() {
    return this.cfg.enabled !== false
  }

  async tick() {
    if (!this.host || !this.enabled) return
    const windows = this.restWindows
    if (windows.length && inRestWindow(windows, new Date(this.now()))) {
      this.sleeping = true
      this.drain()
      return
    }
    this.drain()
    if (this.sleeping) {
      this.sleeping = false
      this.wakeFromRest()
    }
    this.resolveGrace()
    this.maybeThink()
  }

  /** A rest window ended: the quiet is gone, the chance is back to the start, the clock is 0. */
  wakeFromRest() {
    this.lastChatAt = this.now()
    this.lastBucket = -1
    this.pendingThoughtAt = 0
    this.graceSpokeAt = 0
    this.graceFrom = 0
    this.unanswered = 0
    this.save()
    this.host?.log.info('proactive: 休息结束，计时从 0 开始')
  }

  /** The pet spoke but nobody answered within the grace: give the silence back, keep the chance. */
  resolveGrace() {
    if (!this.graceSpokeAt) return
    if (this.now() - this.graceSpokeAt < this.graceMs) return
    this.lastChatAt = this.graceFrom || this.lastChatAt
    this.graceSpokeAt = 0
    this.graceFrom = 0
    this.unanswered += 1
    this.save()
  }

  /** Reads what happened since the last tick: the person writing, or the pet speaking. */
  drain() {
    const host = this.host
    if (!host) return
    for (let guard = 0; guard < 20; guard += 1) {
      let events = []
      try {
        events = host.store.range({ fromCursor: this.cursor + 1, limit: 200 })
      } catch {
        return
      }
      if (!events.length) return
      for (const event of events) {
        this.cursor = Math.max(this.cursor, event.cursor)
        this.handle(event)
      }
      if (events.length < 200) return
    }
  }

  handle(event) {
    const meta = event.meta ?? {}
    if (this.isOwnerMessage(event)) {
      this.lastChatAt = Date.parse(event.ts) || this.now()
      this.pendingThoughtAt = 0
      this.graceSpokeAt = 0
      this.graceFrom = 0
      this.unanswered = 0
      this.lastBucket = -1
      this.save()
      return
    }
    if (this.isPetSpeech(event)) {
      const answered = this.pendingThoughtAt && this.now() - this.pendingThoughtAt <= PENDING_MS
      if (answered) {
        this.graceFrom = this.graceSpokeAt ? this.graceFrom : this.lastChatAt
        this.graceSpokeAt = this.now()
        this.pendingThoughtAt = 0
        this.save()
      }
    }
  }

  isOwnerMessage(event) {
    const meta = event.meta ?? {}
    if (event.type === 'desktop-pet.message' || event.type === 'desktop-pet.speech' || event.type === 'desktop-pet.answer') {
      return true
    }
    if ((event.type === 'qq.message' || event.type === 'telegram.message') && meta.role === 'owner') return true
    return false
  }

  isPetSpeech(event) {
    if (event.type !== 'desktop-pet.self') return false
    const meta = event.meta ?? {}
    if (meta.kind === 'say' || meta.kind === 'ask') return true
    if (meta.kind === 'activity' && Array.isArray(meta.steps)) {
      return meta.steps.some((step) => SPEAK_STEPS.has(String(step)))
    }
    return false
  }

  maybeThink() {
    if (this.graceSpokeAt) return
    if (this.pendingThoughtAt && this.now() - this.pendingThoughtAt < PENDING_MS) return
    const idle = this.idleMinutes()
    const start = number(this.cfg.idleMinutes, 30)
    if (idle < start) return
    const step = Math.max(1, number(this.cfg.stepMinutes, 10))
    const bucket = Math.floor((idle - start) / step)
    if (bucket <= this.lastBucket) return
    this.lastBucket = bucket
    this.save()

    const chance = chanceFor(this.cfg, idle)
    if (this.random() * 100 >= chance) return

    const thought = thoughtFor(this.levels, idle, this.ownerName, this.random)
    if (!thought) return
    this.throwThought(thought, idle, chance)
  }

  throwThought(text, idle, chance) {
    const host = this.host
    if (!host) return
    this.thrown += 1
    this.pendingThoughtAt = this.now()
    this.save()
    host.log.info(`proactive: 第 ${this.thrown} 次内心想法（空闲 ${Math.round(idle)} 分钟，概率 ${chance}%）`)
    void host
      .pushEvent(
        {
          type: `${WORLD_ID}.thought`,
          source: WORLD_ID,
          ts: new Date(this.now()).toISOString(),
          origin: 'internal',
          text: `内心想法：${text}${this.unanswered > 0 ? '（之前好像找过，但是没有回复，要不要换一种方式？）' : ''}`,
          meta: { kind: 'thought', idleMinutes: Math.round(idle), chance },
        },
        { trigger: 'flush' },
      )
      .catch(() => {})
  }

  tools() {
    return []
  }

  envPromptVars() {
    return {}
  }

  webUi() {
    const idle = Math.round(this.idleMinutes())
    return {
      label: '主动想念',
      lamps: [
        {
          label: '计时',
          state: this.host ? 'online' : 'offline',
          hint: `上次聊天：${this.lastChatAt ? new Date(this.lastChatAt).toLocaleString() : '未知'}`,
        },
      ],
      badges: [
        { label: '空闲(分)', value: idle, tone: 'plain' },
        { label: '当前概率', value: `${this.chance}%`, tone: 'plain' },
        { label: '已触发', value: this.thrown, tone: 'plain' },
      ],
      config: [
        {
          id: `world:${WORLD_ID}.main`,
          owner: `world:${WORLD_ID}`,
          schema: {
            type: 'object',
            title: '主动想念',
            description:
              '安静超过设定时间后，按逐步升高的概率冒出一个「内心想法」；模型自己决定要不要来找你。',
            properties: {
              [`worlds.${WORLD_ID}.enabled`]: { type: 'boolean', title: '启用', 'x-hot': true },
              [`worlds.${WORLD_ID}.ownerName`]: {
                type: 'string',
                title: '对主人的称呼',
                description: '内心想法里怎么称呼你，比如「主人」。留空用「主人」。',
                'x-hot': true,
              },
              [`worlds.${WORLD_ID}.idleMinutes`]: {
                type: 'integer',
                title: '安静多少分钟后开始（分钟）',
                minimum: 5,
                maximum: 1440,
                'x-hot': true,
              },
              [`worlds.${WORLD_ID}.stepMinutes`]: {
                type: 'integer',
                title: '每过多少分钟加一次概率',
                minimum: 1,
                maximum: 240,
                'x-hot': true,
              },
              [`worlds.${WORLD_ID}.initialChance`]: {
                type: 'integer',
                title: '初始概率(%)',
                minimum: 1,
                maximum: 100,
                'x-hot': true,
              },
              [`worlds.${WORLD_ID}.stepChance`]: {
                type: 'integer',
                title: '每次增加(%)',
                minimum: 1,
                maximum: 100,
                'x-hot': true,
              },
              [`worlds.${WORLD_ID}.maxChance`]: {
                type: 'integer',
                title: '概率上限(%)',
                minimum: 1,
                maximum: 100,
                'x-hot': true,
              },
              [`worlds.${WORLD_ID}.restWindows`]: {
                type: 'string',
                title: '休息时间段',
                description:
                  '这些时间段内不触发、也不主动找。格式 HH:MM-HH:MM，多个用逗号或分号分隔，支持跨午夜（23:00-07:00）。休息结束的那一刻计时从 0 开始、概率回到初始值。留空表示不休息。',
                'x-hot': true,
              },
              [`worlds.${WORLD_ID}.graceMinutes`]: {
                type: 'integer',
                title: '没回复的宽限(分钟)',
                minimum: 1,
                maximum: 120,
                'x-hot': true,
                description: '宠物找过你、但这么多分钟都没回，就把安静计时退回它开口前，概率不降。',
              },
              [`worlds.${WORLD_ID}.levelsJson`]: {
                type: 'string',
                title: '档位与提示词（JSON，可留空）',
                description:
                  '形如 [{"afterMinutes":30,"thoughts":["第一句","第二句"]}, …]；{owner} 会替换成上面的称呼。留空用内置四档。',
                'x-hot': true,
              },
            },
          },
        },
      ],
    }
  }
}

export const definition = {
  id: WORLD_ID,
  label: '主动想念',
  defaults: () => ({
    enabled: true,
    ownerName: DEFAULT_OWNER,
    idleMinutes: 30,
    stepMinutes: 10,
    initialChance: 10,
    stepChance: 10,
    maxChance: 80,
    restWindows: '',
    graceMinutes: 10,
    levelsJson: '',
  }),
  describe: {
    tools: [],
    events: [
      {
        type: `${WORLD_ID}.thought`,
        description: {
          zh: '宠物对主人的一条内心想法；是否真的去找人聊天由模型自己决定。',
          en: "One inner thought the pet has about its person; whether it reaches out is the model's call.",
        },
        trigger: 'flush',
      },
    ],
  },
  create: (ctx) => new ProactiveWorld({ ctx, cfg: ctx?.cfg }),
}

export default definition

/**
 * Standalone test: pure chance/level/thought helpers + a fake host and event store.
 *
 * `node test/run.mjs`
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ProactiveWorld, chanceFor, inRestWindow, parseLevels, parseRestWindows, thoughtFor, levelFor } from '../index.js'

// ---- pure scheduling ----
const cfg = { idleMinutes: 30, stepMinutes: 10, initialChance: 10, stepChance: 10, maxChance: 80 }
assert.equal(chanceFor(cfg, 29), 0)
assert.equal(chanceFor(cfg, 30), 10)
assert.equal(chanceFor(cfg, 40), 20)
assert.equal(chanceFor(cfg, 100), 80)
assert.equal(chanceFor(cfg, 1000), 80)

const levels = parseLevels('')
assert.equal(levelFor(levels, 45).afterMinutes, 30)
assert.equal(levelFor(levels, 61).afterMinutes, 60)
assert.equal(levelFor(levels, 500).afterMinutes, 240)

const first = thoughtFor(levels, 45, '主人', () => 0)
assert.match(first, /主人/)
assert.ok(!first.includes('{owner}'))
const second = thoughtFor(levels, 45, '主人', () => 0.99)
assert.notEqual(first, second, 'the two prompts of a level are different')

assert.equal(parseLevels('not json').length, 4, 'bad JSON falls back to the built-in levels')
assert.deepEqual(
  parseLevels('[{"afterMinutes":5,"thoughts":["嗨 {owner}"]}]')[0].thoughts,
  ['嗨 {owner}'],
)


// ---- rest windows ----
const rest = parseRestWindows('23:00-07:00, 12:00-13:00')
assert.equal(rest.length, 2)
assert.equal(inRestWindow(rest, new Date('2026-10-26T23:30:00')), true, 'overnight window starts before midnight')
assert.equal(inRestWindow(rest, new Date('2026-10-26T06:30:00')), true, 'overnight window runs past midnight')
assert.equal(inRestWindow(rest, new Date('2026-10-26T07:30:00')), false)
assert.equal(inRestWindow(rest, new Date('2026-10-26T12:30:00')), true)
assert.equal(inRestWindow(rest, new Date('2026-10-26T13:30:00')), false)
assert.equal(inRestWindow(parseRestWindows('garbage'), new Date()), false, 'bad input means no rest')// ---- the World ----
let clock = Date.parse('2026-10-26T12:00:00+08:00')
let roll = 0.05
const events = []
let cursor = 0
const thrown = []
const host = {
  log: {
    info: () => {},
    warn: () => {},
    error: (line) => console.error('[error]', line),
    debug: () => {},
  },
  store: {
    latestCursor: () => cursor,
    range: ({ fromCursor = 0, limit = 200 } = {}) =>
      events.filter((e) => e.cursor >= fromCursor).sort((a, b) => a.cursor - b.cursor).slice(0, limit),
  },
  modelFacts: {},
  async pushEvent(event) {
    thrown.push(event)
    return { cursor: ++cursor, ...event }
  },
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proactive-'))
const world = new ProactiveWorld({
  cfg: { ...cfg, ownerName: '主人' },
  ctx: { dataDir: dir },
  now: () => clock,
  random: () => roll,
})

await world.start(host)
assert.equal(world.idleMinutes(), 0)

// 31 minutes of quiet, roll succeeds
clock += 31 * 60_000
await world.tick()
assert.equal(thrown.length, 1, 'a thought is pushed')
assert.match(thrown[0].text, /^内心想法：/)
assert.match(thrown[0].text, /主人/)
assert.equal(thrown[0].origin, 'internal')
assert.equal(thrown[0].meta.kind, 'thought')

// the same bucket never fires twice
await world.tick()
assert.equal(thrown.length, 1)

// next bucket, arithmetic says 20%, the roll (50) misses
roll = 0.5
clock += 10 * 60_000
await world.tick()
assert.equal(thrown.length, 1, 'a missed roll adds no thought')

// the person writes: the clock resets and the chance falls back to the initial value
events.push({
  cursor: ++cursor,
  type: 'telegram.message',
  ts: new Date(clock).toISOString(),
  meta: { role: 'owner' },
  text: '在吗',
})
await world.tick()
assert.equal(world.idleMinutes(), 0)
assert.equal(world.chance, 0)

// quiet again, a thought fires; the pet answers it, opening a grace period
clock += 31 * 60_000
roll = 0.01
await world.tick()
assert.equal(thrown.length, 2)
const beforeSpeech = world.lastChatAt
events.push({
  cursor: ++cursor,
  type: 'desktop-pet.self',
  ts: new Date(clock).toISOString(),
  meta: { kind: 'say', beats: [{ text: '在的呀' }] },
  text: '说了点什么',
})
await world.tick()
assert.ok(world.graceSpokeAt > 0, 'speaking opens a grace period')
assert.equal(world.lastChatAt, beforeSpeech, 'speaking alone does not reset the clock')
assert.equal(world.unanswered, 0)

// nobody answers within the grace: the clock goes back, the chance stays, the attempt is remembered
clock += 11 * 60_000
await world.tick()
assert.equal(world.unanswered, 1)
assert.equal(world.lastChatAt, beforeSpeech, 'the grace gives the silence back')
assert.ok(world.idleMinutes() >= 40)
assert.equal(thrown.length, 3, 'the next bucket gets its roll')
assert.match(thrown[2].text, /之前好像找过，但是没有回复，要不要换一种方式/)

// a reply during the grace resets everything
events.push({
  cursor: ++cursor,
  type: 'desktop-pet.self',
  ts: new Date(clock).toISOString(),
  meta: { kind: 'say', beats: [{ text: '还在吗' }] },
  text: '又说了点什么',
})
await world.tick()
assert.ok(world.graceSpokeAt > 0, 'the second attempt also opens a grace')
events.push({
  cursor: ++cursor,
  type: 'desktop-pet.message',
  ts: new Date(clock).toISOString(),
  meta: { via: 'chat', text: '在' },
  text: '在',
})
await world.tick()
assert.equal(world.graceSpokeAt, 0, 'a reply during the grace closes it')
assert.equal(world.unanswered, 0, 'a real reply forgets the unanswered attempts')
assert.equal(world.idleMinutes(), 0)

// state survives a restart
const savedIdle = world.idleMinutes()
await world.stop()
const again = new ProactiveWorld({ cfg: { ...cfg, ownerName: '主人' }, ctx: { dataDir: dir }, now: () => clock })
again.load()
assert.ok(Math.abs(again.idleMinutes() - savedIdle) < 1, 'the last chat time is persisted')


// ---- resting: no thoughts, and the clock restarts when the window ends ----
const restDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proactive-rest-'))
const restThrown = []
let restCursor = 0
const restHost = {
  log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  store: { latestCursor: () => restCursor, range: () => [] },
  modelFacts: {},
  async pushEvent(event) { restThrown.push(event); return { cursor: ++restCursor, ...event } },
}
clock = Date.parse('2026-10-26T11:00:00+08:00')
const napper = new ProactiveWorld({
  cfg: { ...cfg, ownerName: '主人', restWindows: '00:00-12:00' },
  ctx: { dataDir: restDir },
  now: () => clock,
  random: () => 0.01,
})
await napper.start(restHost)
await napper.tick()
assert.equal(napper.sleeping, true, 'the tick inside the window sleeps')
clock += 40 * 60_000
await napper.tick()
assert.equal(restThrown.length, 0, 'no thought while resting')

clock = Date.parse('2026-10-26T12:05:00+08:00')
await napper.tick()
assert.equal(napper.sleeping, false)
assert.equal(napper.idleMinutes(), 0, 'the window end starts the clock at zero')
assert.equal(napper.chance, 0)

clock += 31 * 60_000
await napper.tick()
assert.equal(restThrown.length, 1, 'the first bucket fires after the rest')
await napper.stop()
fs.rmSync(restDir, { recursive: true, force: true })

// ---- qq_send counts as reaching out, and an unanswered thought blocks a new one ----
const talkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proactive-talk-'))
const talkThrown = []
const talkEvents = []
let talkCursor = 0
const talkHost = {
  log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  store: {
    latestCursor: () => talkCursor,
    range: ({ fromCursor = 0, limit = 200 } = {}) =>
      talkEvents.filter((e) => e.cursor >= fromCursor).sort((a, b) => a.cursor - b.cursor).slice(0, limit),
  },
  modelFacts: {},
  async pushEvent(event) { talkThrown.push(event); return { cursor: ++talkCursor, ...event } },
}
clock = Date.parse('2026-10-26T10:00:00+08:00')
const talker = new ProactiveWorld({
  cfg: { ...cfg, ownerName: '主人', idleMinutes: 30, stepMinutes: 1 },
  ctx: { dataDir: talkDir },
  now: () => clock,
  random: () => 0.01,
})
await talker.start(talkHost)
clock += 31 * 60_000
await talker.tick()
assert.equal(talkThrown.length, 1, 'first thought')
clock += 60_000
await talker.tick()
assert.equal(talkThrown.length, 1, 'an unanswered thought is not repeated inside 15 minutes')

// the pet reaches out on QQ: an activity step is enough to start the grace
talkEvents.push({
  cursor: ++talkCursor,
  type: 'desktop-pet.self',
  ts: new Date(clock).toISOString(),
  meta: { kind: 'activity', steps: ['qq_send'] },
  text: '做了:qq_send',
})
await talker.tick()
assert.ok(talker.graceSpokeAt > 0, 'qq_send counts as speaking')
assert.equal(talker.pendingThoughtAt, 0)
await talker.stop()
fs.rmSync(talkDir, { recursive: true, force: true })
fs.rmSync(dir, { recursive: true, force: true })
console.log('ok: 概率递增、档位提示词、同档不重复、宽限退回与「之前找过」独白、回复归零、休息窗口内静默与结束后归零、状态持久化')

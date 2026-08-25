/**
 * Pure-function unit tests for the cleanup planning core.
 * Run: node test-cleanup.mjs  (imports the compiled lib/)
 */
import assert from 'node:assert/strict'
import { isSubagentDirName, planSessionActions } from './lib/index.js'

let passed = 0
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok ${name}`)
  } catch (error) {
    console.error(`  FAIL ${name}`)
    throw error
  }
}

console.log('isSubagentDirName')
check('bare lowercase uuid is subagent-shaped', () => {
  assert.equal(isSubagentDirName('d0d95448-44b7-4d8e-b6f8-36c319b11bab'), true)
})
check('session- prefix is main, not subagent', () => {
  assert.equal(isSubagentDirName('session-d0d95448-44b7-4d8e-b6f8-36c319b11bab'), false)
})
check('uppercase hex rejected (ids are randomUUID, always lowercase)', () => {
  assert.equal(isSubagentDirName('D0D95448-44B7-4D8E-B6F8-36C319B11BAB'), false)
})
check('non-uuid junk rejected', () => {
  assert.equal(isSubagentDirName('not-a-session'), false)
  assert.equal(isSubagentDirName(''), false)
})

console.log('planSessionActions — enumerated children (self/parent mode)')
const NOW = 1_800_000_000_000
const policy = { nowMs: NOW, processStartMs: undefined, minIdleMs: 0, settleBufferMs: 30_000, liveBufferMs: 600_000 }

check('inactive child past settle buffer is eligible', () => {
  const [entry] = planSessionActions(
    [{ id: 'a', workspaceDir: 'w', lastWriteMs: NOW - 60_000, sizeBytes: 1, activity: 'inactive', ancestorLive: false }],
    policy,
  )
  assert.equal(entry.eligible, true)
})
check('inactive child just settled (< buffer) is skipped', () => {
  const [entry] = planSessionActions(
    [{ id: 'a', workspaceDir: 'w', lastWriteMs: NOW - 5_000, sizeBytes: 1, activity: 'inactive', ancestorLive: false }],
    policy,
  )
  assert.equal(entry.eligible, false)
  assert.equal(entry.skipReason, 'just-settled')
})
check('running child with live ancestor is skipped (subtree)', () => {
  const [entry] = planSessionActions(
    [{ id: 'a', workspaceDir: 'w', lastWriteMs: NOW - 3_600_000, sizeBytes: 1, activity: 'running', ancestorLive: true }],
    policy,
  )
  assert.equal(entry.eligible, false)
  assert.equal(entry.skipReason, 'subtree-live')
})
check('running child silent past live buffer is eligible', () => {
  const [entry] = planSessionActions(
    [{ id: 'a', workspaceDir: 'w', lastWriteMs: NOW - 601_000, sizeBytes: 1, activity: 'running', ancestorLive: false }],
    policy,
  )
  assert.equal(entry.eligible, true)
})
check('running child recently written is skipped', () => {
  const [entry] = planSessionActions(
    [{ id: 'a', workspaceDir: 'w', lastWriteMs: NOW - 10_000, sizeBytes: 1, activity: 'running', ancestorLive: false }],
    policy,
  )
  assert.equal(entry.eligible, false)
  assert.equal(entry.skipReason, 'possibly-live')
})
check('dir with no files is skipped', () => {
  const [entry] = planSessionActions(
    [{ id: 'a', workspaceDir: 'w', lastWriteMs: undefined, sizeBytes: 0, activity: 'inactive', ancestorLive: false }],
    policy,
  )
  assert.equal(entry.eligible, false)
  assert.equal(entry.skipReason, 'empty-dir')
})

console.log('planSessionActions — directory-shape sweep (global mode)')
const PROCESS_START = NOW - 86_400_000 // process up for one day
const sweepPolicy = { nowMs: NOW, processStartMs: PROCESS_START, minIdleMs: 24 * 3_600_000, settleBufferMs: 30_000, liveBufferMs: 600_000 }

check('cold dir untouched since before process start, idle 25h → eligible', () => {
  const [entry] = planSessionActions(
    [{ id: 'a', workspaceDir: 'w', lastWriteMs: NOW - 25 * 3_600_000, sizeBytes: 1, activity: 'unknown', ancestorLive: false }],
    sweepPolicy,
  )
  assert.equal(entry.eligible, true)
})
check('dir written after process start is skipped (attached risk)', () => {
  const [entry] = planSessionActions(
    [{ id: 'a', workspaceDir: 'w', lastWriteMs: NOW - 30 * 3_600_000, sizeBytes: 1, activity: 'unknown', ancestorLive: false }],
    { ...sweepPolicy, processStartMs: NOW - 48 * 3_600_000 },
  )
  assert.equal(entry.eligible, false)
  assert.equal(entry.skipReason, 'attached-unknown')
})
check('cold since before process start but idle only 2h → skipped too-recent', () => {
  const [entry] = planSessionActions(
    [{ id: 'a', workspaceDir: 'w', lastWriteMs: NOW - 2 * 3_600_000, sizeBytes: 1, activity: 'unknown', ancestorLive: false }],
    { ...sweepPolicy, processStartMs: NOW - 1 * 3_600_000 },
  )
  assert.equal(entry.eligible, false)
  assert.equal(entry.skipReason, 'too-recent')
})
check('idle gate disabled (minIdleMs 0) still respects process start', () => {
  // written 3h ago, process started 2h ago: write predates start → eligible once gate is off
  const [pass] = planSessionActions(
    [{ id: 'a', workspaceDir: 'w', lastWriteMs: NOW - 3 * 3_600_000, sizeBytes: 1, activity: 'unknown', ancestorLive: false }],
    { ...sweepPolicy, minIdleMs: 0, processStartMs: NOW - 2 * 3_600_000 },
  )
  assert.equal(pass.eligible, true)
  // same write, but process started 5h ago: write postdates start → still blocked
  const [block] = planSessionActions(
    [{ id: 'a', workspaceDir: 'w', lastWriteMs: NOW - 3 * 3_600_000, sizeBytes: 1, activity: 'unknown', ancestorLive: false }],
    { ...sweepPolicy, minIdleMs: 0, processStartMs: NOW - 5 * 3_600_000 },
  )
  assert.equal(block.eligible, false)
  assert.equal(block.skipReason, 'attached-unknown')
})

console.log(`\n${passed} checks passed`)

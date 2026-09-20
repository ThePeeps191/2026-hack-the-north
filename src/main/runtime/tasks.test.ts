import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Task } from '../../shared/types.ts'
import {
  applyTaskPatch,
  buildTask,
  dependenciesSatisfied,
  interruptedTasks,
  nextRunnableTask,
  plannedBefore,
  rejectStaleResult,
  refreshStaleTask,
  staleTask,
  summarizeTaskGraph,
  type GraphClock
} from './tasks.ts'

function clock(): GraphClock {
  let n = 0
  return {
    newId: () => `id-${++n}`,
    now: () => new Date(1_700_000_000_000 + n * 1000).toISOString()
  }
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    roomId: 'r1',
    title: 'Build the vote panel',
    detail: '',
    ownerAgentId: 'maya',
    createdBy: { type: 'human' },
    status: 'assigned',
    dependsOn: [],
    acceptance: ['the panel renders'],
    decisionRevision: 1,
    staleSince: null,
    staleReason: null,
    blockedReason: null,
    evidence: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over
  }
}

describe('task graph', () => {
  test('a task owned by an agent with satisfied dependencies is runnable', () => {
    const tasks = [task({ id: 't1', ownerAgentId: 'maya' })]
    assert.equal(nextRunnableTask(tasks, 'maya')?.id, 't1')
    assert.equal(nextRunnableTask(tasks, 'alex'), null)
  })

  test('unfinished dependencies block the dependent task', () => {
    const tasks = [
      task({ id: 't1', ownerAgentId: 'alex', status: 'in_progress' }),
      task({ id: 't2', ownerAgentId: 'maya', dependsOn: ['t1'] })
    ]
    assert.equal(nextRunnableTask(tasks, 'maya'), null)
    assert.equal(dependenciesSatisfied(tasks[1], tasks), false)

    const done = [tasks[0], { ...tasks[1] }, { ...tasks[0], status: 'done' as const }]
    assert.equal(nextRunnableTask([done[2], done[1]], 'maya')?.id, 't2')
  })

  test('a failed dependency does not silently release work', () => {
    const tasks = [
      task({ id: 't1', status: 'failed' }),
      task({ id: 't2', ownerAgentId: 'maya', dependsOn: ['t1'] })
    ]
    assert.equal(dependenciesSatisfied(tasks[1], tasks), false)
  })

  test('a missing dependency never blocks the graph forever', () => {
    const tasks = [task({ id: 't2', ownerAgentId: 'maya', dependsOn: ['gone'] })]
    assert.equal(dependenciesSatisfied(tasks[0], tasks), true)
  })

  test('in-progress work is preferred over newly assigned work', () => {
    const tasks = [
      task({ id: 't1', ownerAgentId: 'maya', status: 'assigned', createdAt: '2026-01-01T00:00:00.000Z' }),
      task({ id: 't2', ownerAgentId: 'maya', status: 'in_progress', createdAt: '2026-01-02T00:00:00.000Z' })
    ]
    assert.equal(nextRunnableTask(tasks, 'maya')?.id, 't2')
  })

  test('terminal tasks are never picked up again', () => {
    for (const status of ['done', 'cancelled', 'failed'] as const) {
      const tasks = [task({ status })]
      assert.equal(nextRunnableTask(tasks, 'maya'), null, status)
    }
  })
})

describe('task records', () => {
  test('buildTask records the owner, acceptance and decision revision', () => {
    const created = buildTask(clock(), {
      roomId: 'r1',
      title: 'Wire the vote endpoint',
      detail: 'POST /api/votes',
      ownerAgentId: 'alex',
      createdBy: { type: 'human' },
      acceptance: ['a 201 is returned'],
      decisionRevision: 4
    })
    assert.equal(created.status, 'assigned')
    assert.equal(created.ownerAgentId, 'alex')
    assert.equal(created.decisionRevision, 4)
    assert.deepEqual(created.acceptance, ['a 201 is returned'])
    assert.equal(created.staleSince, null)
  })

  test('an unowned task is proposed, and assigning it promotes it', () => {
    const created = buildTask(clock(), { roomId: 'r1', title: 'Decide the export format', createdBy: { type: 'human' }, decisionRevision: 1 })
    assert.equal(created.status, 'proposed')
    const assigned = applyTaskPatch(created, { ownerAgentId: 'sam' }, '2026-02-01T00:00:00.000Z')
    assert.equal(assigned.status, 'assigned')
    assert.equal(assigned.ownerAgentId, 'sam')
  })

  test('patching keeps the previous evidence and updates the timestamp', () => {
    const original = task({ evidence: [{ kind: 'file', path: 'src/App.tsx' }] })
    const patched = applyTaskPatch(original, { status: 'awaiting_review' }, '2026-02-02T00:00:00.000Z')
    assert.equal(patched.status, 'awaiting_review')
    assert.equal(patched.evidence.length, 1)
    assert.equal(patched.updatedAt, '2026-02-02T00:00:00.000Z')
    assert.equal(original.status, 'assigned')
  })
})

describe('decision revisions', () => {
  test('a task planned before the current revision is stale-eligible', () => {
    assert.equal(plannedBefore(task({ decisionRevision: 2 }), 3), true)
    assert.equal(plannedBefore(task({ decisionRevision: 3 }), 3), false)
  })

  test('staleTask records the reason once and keeps it', () => {
    const first = staleTask(task(), 5, 'Requirement change r5: dark mode', '2026-03-01T00:00:00.000Z')
    assert.equal(first.staleReason, 'Requirement change r5: dark mode')
    const second = staleTask(first, 6, 'Requirement change r6: light mode', '2026-03-02T00:00:00.000Z')
    assert.equal(second.staleSince, '2026-03-01T00:00:00.000Z')
    assert.equal(second.staleReason, 'Requirement change r6: light mode')
  })

  test('a submission from an older revision is rejected, not merged', () => {
    const verdict = rejectStaleResult(task({ decisionRevision: 2 }), 4, 'The submission')
    assert.equal(verdict.stale, true)
    assert.match(verdict.reason ?? '', /revision 2.*revision 4/s)
  })

  test('a submission against the current revision is allowed', () => {
    assert.equal(rejectStaleResult(task({ decisionRevision: 4 }), 4, 'The submission').stale, false)
  })

  test('refreshStaleTask re-bases the task on the current revision', () => {
    const stale = staleTask(task(), 5, 'requirement changed', '2026-03-01T00:00:00.000Z')
    const refreshed = refreshStaleTask(stale, 5, '2026-03-02T00:00:00.000Z')
    assert.equal(refreshed.staleSince, null)
    assert.equal(refreshed.staleReason, null)
    assert.equal(refreshed.decisionRevision, 5)
  })
})

describe('restart reconciliation', () => {
  test('only mid-flight work is marked interrupted; assigned work is left alone', () => {
    const tasks = [
      task({ id: 't1', status: 'in_progress' }),
      task({ id: 't2', status: 'assigned' }),
      task({ id: 't3', status: 'done' })
    ]
    const reconciled = interruptedTasks(tasks, '2026-04-01T00:00:00.000Z')
    assert.equal(reconciled.length, 1)
    assert.equal(reconciled[0].id, 't1')
    assert.equal(reconciled[0].status, 'blocked')
    assert.match(reconciled[0].blockedReason ?? '', /Interrupted/)
  })
})

describe('task board summary', () => {
  test('the summary names owners, stale flags and acceptance criteria', () => {
    const tasks = [
      task({ id: 't1', title: 'Vote panel', ownerAgentId: 'maya', staleSince: '2026-05-01T00:00:00.000Z', staleReason: 'r2 changed the layout' })
    ]
    const text = summarizeTaskGraph({ tasks, agents: [{ id: 'maya', name: 'Maya' }] })
    assert.match(text, /Vote panel/)
    assert.match(text, /owner=Maya/)
    assert.match(text, /STALE/)
    assert.match(text, /acceptance: the panel renders/)
  })

  test('an empty board says so instead of inventing tasks', () => {
    assert.equal(summarizeTaskGraph({ tasks: [], agents: [] }), 'No tasks yet.')
  })
})

describe('re-planning a stale task', () => {
  test('moving a task to a newer decision revision clears the stale flag', () => {
    // The flag used to be permanent: a teammate could re-read the new decision,
    // confirm its work still matched, and still never be allowed to submit —
    // so its branch never reached integration and the team verified a revision
    // with half the work missing.
    const base = buildTask(clock(), {
      roomId: 'r1',
      title: 'Strip voter identity from the client',
      detail: '',
      ownerAgentId: 'maya',
      createdBy: { type: 'human' },
      decisionRevision: 0
    })
    const stale = staleTask(base, 1, 'Requirement change r1', '2026-01-01T00:01:00.000Z')
    assert.notEqual(stale.staleSince, null)

    const replanned = applyTaskPatch(stale, { decisionRevision: 1 }, '2026-01-01T00:02:00.000Z')
    assert.equal(replanned.staleSince, null)
    assert.equal(replanned.staleReason, null)
    assert.equal(replanned.decisionRevision, 1)
    assert.equal(plannedBefore(replanned, 1), false, 'the task may now be submitted')
  })

  test('a revision that does not move forward leaves the flag alone', () => {
    const base = buildTask(clock(), {
      roomId: 'r1',
      title: 'Something',
      detail: '',
      ownerAgentId: 'maya',
      createdBy: { type: 'human' },
      decisionRevision: 2
    })
    const stale = staleTask(base, 3, 'Requirement change r3', '2026-01-01T00:01:00.000Z')
    const unchanged = applyTaskPatch(stale, { decisionRevision: 2 }, '2026-01-01T00:02:00.000Z')
    assert.notEqual(unchanged.staleSince, null, 'still stale against revision 3')
  })
})

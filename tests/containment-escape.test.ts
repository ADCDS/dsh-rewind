/**
 * Restore containment against a workspace-confined model.
 *
 * A model confined to the workspace can still rename, delete and symlink inside
 * it. A rewind then runs through raw node:fs in the Host, outside that sandbox,
 * so nothing it does may reach a file outside the location the entry recorded.
 * Every test here plays the model's filesystem moves against a real store and a
 * real disk, then asserts on the bytes and modes of a file outside the workspace.
 */
import { execFile } from 'node:child_process'
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultProbe, locationPin, reconcileTracked, SnapshotStore, withPinnedDir, type DiskProbe } from '../src/snapshot.ts'

const run = promisify(execFile)
const session = 'session-containment'
const linuxOnly = process.platform === 'linux'

const unlink = async (path: string): Promise<void> => {
  await rm(path)
}

let root: string
let outside: string
let store: SnapshotStore

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-rewind-containment-')))
  outside = join(root, 'outside')
  await mkdir(outside)
  store = new SnapshotStore(join(root, 'store'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function touch(rel: string, content: string): Promise<string> {
  const abs = join(root, 'ws', rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content, 'utf8')
  return abs
}

/** Capture one file exactly the way the host does (staged byte copy, commit). */
async function capture(callId: string, anchorSeq: number, live: string): Promise<void> {
  const staged = await store.stageCapture(session, callId)
  const copied = await defaultProbe.copy(live, staged)
  if (copied.kind === 'failed') throw new Error(copied.message)
  await store.recordBackup(session, { callId, anchorSeq, path: live },
    copied.kind === 'absent' ? null : { file: staged, size: copied.size })
}

/** The model's move: replace a workspace directory with a link leaving the workspace. */
async function pointAtOutside(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
  await symlink(outside, dir, 'dir')
}

/** A probe that runs `swap` after the rescue copy: past planning, before the write. */
function swappingAfterPlan(swap: () => Promise<void>): DiskProbe {
  return {
    ...defaultProbe,
    copy: async (path, dest) => {
      const copied = await defaultProbe.copy(path, dest)
      await swap()
      return copied
    },
  }
}

describe('a boundary record for a path whose directory vanished', () => {
  it('cannot delete through a directory later recreated as a symlink', async () => {
    const live = await touch('d/authorized_keys', 'agent')
    await capture('w1', 1, live)
    await rm(dirname(live), { recursive: true })
    expect(await reconcileTracked(store, session, 5, new Set([live]))).toBe(1)
    const victim = join(outside, 'authorized_keys')
    await writeFile(victim, 'user keys')
    await pointAtOutside(dirname(live))

    expect(await store.impactsAfter(session, 5)).toEqual([])
    const outcome = await store.restoreAfter(session, 5, unlink)

    expect(outcome.deleted).toEqual([])
    expect(outcome.skipped).toEqual([live])
    expect(await readFile(victim, 'utf8')).toBe('user keys')
  })

  it('pins where the directory would have been', async () => {
    const live = await touch('d/e/f.txt', 'x')
    await capture('w1', 1, live)
    await rm(join(root, 'ws', 'd'), { recursive: true })
    await reconcileTracked(store, session, 5, new Set([live]))
    const [newest] = await store.entriesAfter(session, 5)
    expect(newest?.parent).toBe(join(root, 'ws', 'd', 'e'))
  })

  it('still recreates a deleted directory when restoring its file', async () => {
    const live = await touch('d/e/f.txt', 'before')
    await capture('w1', 1, live)
    await rm(join(root, 'ws', 'd'), { recursive: true })

    const outcome = await store.restoreAfter(session, 1, unlink)

    expect(outcome.restored).toEqual([live])
    expect(await readFile(live, 'utf8')).toBe('before')
  })
})

describe('a boundary record for a directory repointed outside', () => {
  it('records nothing and never adopts the outside location', async () => {
    const live = await touch('d/cfg', 'workspace')
    await capture('w1', 1, live)
    const victim = join(outside, 'cfg')
    await writeFile(victim, 'OUTSIDE-V1')
    await pointAtOutside(dirname(live))

    expect(await reconcileTracked(store, session, 5, new Set([live]))).toBe(0)
    await writeFile(victim, 'OUTSIDE-V2-USER-EDIT')
    const outcome = await store.restoreAfter(session, 5, unlink)

    expect(outcome.restored).toEqual([])
    expect(await readFile(victim, 'utf8')).toBe('OUTSIDE-V2-USER-EDIT')
  })
})

describe('an entry with no recorded location', () => {
  /** Write an entry the way a build that could not resolve the parent did. */
  async function unpinnedEntry(live: string, before: string | null): Promise<void> {
    const dir = store.anchorDir(session, 1)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'e.json'), JSON.stringify({
      store: 2, callId: 'c1', file: live, blob: before === null ? null : 'e.before', size: before?.length ?? 0, time: 1,
    }))
    if (before !== null) await writeFile(join(dir, 'e.before'), before)
  }

  it('is skipped and reported instead of deleted', async () => {
    const live = await touch('d/f.txt', 'current')
    await unpinnedEntry(live, null)

    expect(await store.impactsAfter(session, 1)).toEqual([])
    const outcome = await store.restoreAfter(session, 1, unlink)

    expect(outcome.skipped).toEqual([live])
    expect(await readFile(live, 'utf8')).toBe('current')
  })

  it('is skipped and reported instead of written', async () => {
    const live = await touch('d/f.txt', 'current')
    await unpinnedEntry(live, 'older')

    const outcome = await store.restoreAfter(session, 1, unlink)

    expect(outcome.restored).toEqual([])
    expect(outcome.skipped).toEqual([live])
    expect(await readFile(live, 'utf8')).toBe('current')
  })
})

describe('the location pin taken at capture time', () => {
  it('wins over where the directory resolves at commit', async () => {
    const live = await touch('d/f.txt', 'before')
    const pin = await locationPin(live)
    const staged = await store.stageCapture(session, 'c1')
    const copied = await defaultProbe.copy(live, staged)
    if (copied.kind !== 'copied') throw new Error('capture failed')
    await pointAtOutside(dirname(live))

    await store.recordBackup(session, { callId: 'c1', anchorSeq: 1, path: live },
      { file: staged, size: copied.size }, { parent: pin })

    const [entry] = await store.entriesAfter(session, 0)
    expect(entry?.parent).toBe(join(root, 'ws', 'd'))
  })
})

describe('a final path component swapped after planning', () => {
  async function plannedRestore(live: string, swap: () => Promise<void>) {
    return store.restoreAfter(session, 1, unlink, swappingAfterPlan(swap))
  }

  it('is not written through when it became a symlink', async () => {
    const live = await touch('d/f.txt', 'model bytes')
    await capture('c1', 1, live)
    await writeFile(live, 'changed')
    const victim = join(outside, 'bashrc')
    await writeFile(victim, 'user bytes')

    const outcome = await plannedRestore(live, async () => {
      await rm(live)
      await symlink(victim, live)
    })

    expect(outcome.restored).toEqual([])
    expect(outcome.failed.map(item => item.path)).toEqual([live])
    expect(await readFile(victim, 'utf8')).toBe('user bytes')
  })

  it('does not change the mode of a symlink target', async () => {
    const live = await touch('d/f.txt', 'model bytes')
    await chmod(live, 0o444)
    const staged = await store.stageCapture(session, 'c1')
    const copied = await defaultProbe.copy(live, staged)
    if (copied.kind !== 'copied') throw new Error('capture failed')
    await store.recordBackup(session, { callId: 'c1', anchorSeq: 1, path: live },
      { file: staged, size: copied.size, mode: 0o777 })
    await chmod(live, 0o644)
    await writeFile(live, 'changed')
    const victim = join(outside, 'secret')
    await writeFile(victim, 'user bytes')
    await chmod(victim, 0o400)

    await plannedRestore(live, async () => {
      await rm(live)
      await symlink(victim, live)
    })

    expect((await stat(victim)).mode & 0o777).toBe(0o400)
    expect(await readFile(victim, 'utf8')).toBe('user bytes')
  })

  it('is not written through when it became a hard link', async () => {
    const live = await touch('d/f.txt', 'model bytes')
    await capture('c1', 1, live)
    await writeFile(live, 'changed')
    const victim = join(outside, 'hard')
    await writeFile(victim, 'user bytes')

    const outcome = await plannedRestore(live, async () => {
      await rm(live)
      await link(victim, live)
    })

    expect(outcome.restored).toEqual([])
    expect(await readFile(victim, 'utf8')).toBe('user bytes')
  })

  it('does not hang when it became a FIFO', async () => {
    const live = await touch('d/f.txt', 'model bytes')
    await capture('c1', 1, live)
    await writeFile(live, 'changed')

    const outcome = await plannedRestore(live, async () => {
      await rm(live)
      await run('mkfifo', [live])
    })

    expect(outcome.restored).toEqual([])
    expect(outcome.failed.map(item => item.path)).toEqual([live])
  }, 5_000)

  it('still restores an untouched file and keeps a read-only mode', async () => {
    const live = await touch('d/f.txt', 'before')
    await chmod(live, 0o444)
    const staged = await store.stageCapture(session, 'c1')
    const copied = await defaultProbe.copy(live, staged)
    if (copied.kind !== 'copied') throw new Error('capture failed')
    await store.recordBackup(session, { callId: 'c1', anchorSeq: 1, path: live },
      { file: staged, size: copied.size, mode: 0o444 })
    await chmod(live, 0o644)
    await writeFile(live, 'changed')
    await chmod(live, 0o444)

    const outcome = await store.restoreAfter(session, 1, unlink)

    expect(outcome.restored).toEqual([live])
    expect(await readFile(live, 'utf8')).toBe('before')
    expect((await stat(live)).mode & 0o777).toBe(0o444)
  })
})

describe('the before-state copy', () => {
  it('does not read through a symlink', async () => {
    const victim = join(outside, 'secret')
    await writeFile(victim, 'user bytes')
    const live = join(root, 'ws', 'f.txt')
    await mkdir(dirname(live), { recursive: true })
    await symlink(victim, live)

    const dest = join(root, 'copied')
    const copied = await defaultProbe.copy(live, dest)

    expect(copied.kind).toBe('failed')
    await expect(readFile(dest)).rejects.toThrow()
  })
})

describe('withPinnedDir', () => {
  it('refuses a pinned directory replaced by a symlink', async () => {
    const live = await touch('d/f.txt', 'x')
    const pin = dirname(live)
    await pointAtOutside(pin)

    await expect(withPinnedDir(pin, async () => 'ran')).rejects.toThrow()
  })

  it.runIf(linuxOnly)('refuses an ancestor repointed at an identically named tree', async () => {
    const live = await touch('a/b/f.txt', 'x')
    const pin = dirname(live)
    await mkdir(join(outside, 'a', 'b'), { recursive: true })
    await rm(join(root, 'ws', 'a'), { recursive: true })
    await symlink(join(outside, 'a'), join(root, 'ws', 'a'), 'dir')

    await expect(withPinnedDir(pin, async () => 'ran')).rejects.toThrow()
  })

  it.runIf(linuxOnly)('stays bound to the checked directory while the path is swapped', async () => {
    const live = await touch('d/f.txt', 'x')
    const pin = dirname(live)
    const moved = join(root, 'ws', 'd.moved')
    const victim = join(outside, 'f.txt')
    await writeFile(victim, 'user bytes')

    await withPinnedDir(pin, async (dir) => {
      await rename(pin, moved)
      await symlink(outside, pin, 'dir')
      await writeFile(join(dir, 'f.txt'), 'through the descriptor')
    })

    expect(await readFile(victim, 'utf8')).toBe('user bytes')
    expect(await readFile(join(moved, 'f.txt'), 'utf8')).toBe('through the descriptor')
  })
})

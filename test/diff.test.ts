import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseDiff } from '../src/git/diff.js'

const MULTI = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@',
  ' keep1',
  '-removed',
  '+added1',
  ' keep2',
  '@@ -20,2 +21,3 @@',
  ' ctx1',
  '-gone',
  '+add2',
  '+add3',
  'diff --git a/b.txt b/b.txt',
  'index 333..444 100644',
  '--- a/b.txt',
  '+++ b/b.txt',
  '@@ -5,0 +6,2 @@',
  '+brand1',
  '+brand2',
].join('\n') + '\n'

describe('parseDiff', () => {
  it('parses multiple files and hunks with correct line numbers', () => {
    const parsed = parseDiff(MULTI)
    assert.equal(parsed.files.length, 2)

    const a = parsed.files[0]!
    assert.equal(a.path, 'src/a.ts')
    assert.equal(a.status, 'modified')
    assert.equal(a.hunks.length, 2)
    const h0 = a.hunks[0]!
    assert.deepEqual(h0.added.map((l) => l.text), ['added1'])
    // context newLine 1 (keep1), removed consumes oldLine only, so added1 = newLine 2
    assert.equal(h0.added[0]!.newLine, 2)
    assert.deepEqual(h0.removed.map((l) => l.text), ['removed'])
    assert.equal(h0.removed[0]!.oldLine, 2)
    const h1 = a.hunks[1]!
    assert.deepEqual(h1.added.map((l) => l.newLine), [22, 23])
    assert.equal(h1.removed[0]!.oldLine, 21)

    const b = parsed.files[1]!
    assert.equal(b.path, 'b.txt')
    assert.equal(b.hunks.length, 1)
    assert.deepEqual(b.hunks[0]!.added.map((l) => l.text), ['brand1', 'brand2'])
  })

  it('classifies added / deleted / renamed files and tolerates absent new-file (large) hunks', () => {
    const raw = [
      'diff --git a/nw.ts b/nw.ts',
      'new file mode 100644',
      'index 0000000..abc1234',
      '--- /dev/null',
      '+++ b/nw.ts',
      '@@ -0,0 +1 @@',
      '+ fresh',
      'diff --git a/del.txt b/del.txt',
      'deleted file mode 100644',
      'index abc1234..0000000',
      '--- a/del.txt',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '- old-line',
      'diff --git a/old.ts b/new.ts',
      'similarity index 100%',
      'rename from old.ts',
      'rename to new.ts',
    ].join('\n') + '\n'

    const parsed = parseDiff(raw)
    assert.equal(parsed.files.length, 3)
    assert.equal(parsed.files[0]!.status, 'added')
    assert.equal(parsed.files[0]!.path, 'nw.ts')
    assert.deepEqual(parsed.files[0]!.hunks[0]!.added.map((l) => l.text), [' fresh'])
    assert.equal(parsed.files[1]!.status, 'deleted')
    assert.equal(parsed.files[1]!.path, 'del.txt')
    assert.equal(parsed.files[2]!.status, 'renamed')
    assert.equal(parsed.files[2]!.path, 'new.ts')
    assert.equal(parsed.files[2]!.fromPath, 'old.ts')
  })

  it('skips combined (merge) diffs without corrupting the file list', () => {
    const raw = [
      'diff --cc src/m.ts',
      'index 111,222..333,444',
      '--- a/src/m.ts',
      '+++ b/src/m.ts',
      '@@@ -1,2 -1,2 +1,2 @@@',
      '  same',
      '++next',
    ].join('\n')

    const parsed = parseDiff(raw)
    assert.ok(parsed.files.length >= 1)
    assert.equal(parsed.files[0]!.path, '(merge)')
  })

  it('treats +++/--- as content inside an open hunk, not as file headers', () => {
    const raw = [
      'diff --git a/x.txt b/x.txt',
      'index 111..222 100644',
      '--- a/x.txt',
      '+++ b/x.txt',
      '@@ -1,2 +1,3 @@',
      ' keep',
      '+--- heading',
      '+++ another heading',
      '- -- removed',
    ].join('\n') + '\n'
    const parsed = parseDiff(raw)
    const h = parsed.files[0]!.hunks[0]!
    assert.deepEqual(h.added.map((l) => l.text), ['--- heading', '++ another heading'])
    assert.deepEqual(h.removed.map((l) => l.text), [' -- removed'])
  })

  it('returns zero files for empty input and never throws on malformed text', () => {
    assert.equal(parseDiff('').files.length, 0)
    assert.equal(parseDiff('random junk\nwithout headers\n').files.length, 0)
    assert.equal(parseDiff('diff --git a/x b/x\nunfinished header').files.length, 1)
  })
})

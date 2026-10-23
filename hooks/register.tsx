import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { FileDiff, RepoDiff, Row } from '../types'

const PANE = 'multi-repo-diff'
const repos = atom({ plugin: 'multi-repo-diff', key: 'repos' } as const, [])
const sel = atom({ plugin: 'multi-repo-diff', key: 'sel' } as const, { repo: '', file: '' })
const ctx = atom({ plugin: 'multi-repo-diff', key: 'ctx' } as const, 5)

const CTX_STEPS = [3, 5, 10, 30]
const MAX_ROWS = 1500
const MAX_UNTRACKED = 60
const LIST_ROWS = 10
const STATUS_COLOR = { M: 'yellow', A: 'green', U: 'green', D: 'red' } as const
const BG = { add: '#12261a', del: '#2d1517' } as const

function parse(text: string): FileDiff[] {
  const files: FileDiff[] = []
  let f: FileDiff | undefined
  let inHunk = false
  let o = 0
  let n = 0
  for (const l of text.split('\n')) {
    const head = /^diff --git a\/.* b\/(.*)$/.exec(l)
    if (head) {
      f = { path: head[1], status: 'M', add: 0, del: 0, rows: [] }
      files.push(f)
      inHunk = false
      continue
    }
    if (!f) continue
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l)
    if (hunk) {
      o = Number(hunk[1])
      n = Number(hunk[2])
      inHunk = true
      if (f.rows.length < MAX_ROWS) f.rows.push({ kind: 'hunk', text: l.replace(/^(@@ .*? @@).*/, '$1') + (l.split('@@')[2] ?? '') })
      continue
    }
    if (!inHunk) {
      if (l.startsWith('new file mode')) f.status = 'A'
      else if (l.startsWith('deleted file mode')) f.status = 'D'
      else if (l.startsWith('Binary files')) f.rows.push({ kind: 'note', text: 'Binary file changed' })
      continue
    }
    const t = l.slice(1).replace(/\t/g, '  ')
    let row: Row | undefined
    if (l.startsWith('+')) { f.add++; row = { kind: 'add', neo: n++, text: t } }
    else if (l.startsWith('-')) { f.del++; row = { kind: 'del', old: o++, text: t } }
    else if (l.startsWith(' ')) { row = { kind: 'ctx', old: o++, neo: n++, text: t } }
    if (row && f.rows.length < MAX_ROWS) f.rows.push(row)
  }
  return files
}

// Repos in the cwd's children; the session cwd moves with `cd`, so from inside a repo its sibling repos count too.
async function findRepos($: any): Promise<string[]> {
  const cwd: string = await $.session.cwd()
  const isRepo = async (dir: string) => (await $.fs.stat(`${dir}/.git`).catch(() => null)) !== null
  const within = async (dir: string) => {
    const found: string[] = []
    for (const e of await $.fs.list(dir)) {
      if (e.kind === 'dir' && (await isRepo(`${dir}/${e.name}`))) found.push(`${dir}/${e.name}`)
    }
    return found
  }
  if (!(await isRepo(cwd))) return within(cwd)
  const siblings = await within(cwd.slice(0, cwd.lastIndexOf('/')) || '/')
  return siblings.includes(cwd) ? siblings : [cwd, ...siblings]
}

async function refresh($: any) {
  const context = await read($, ctx)
  const out: RepoDiff[] = []
  for (const dir of await findRepos($)) {
    const git = async (...argv: string[]) =>
      (await $.process.run(['git', '-c', 'core.quotepath=off', ...argv], { cwd: dir })).stdout as string
    const files = parse(await git('diff', 'HEAD', '--no-color', '--no-renames', `-U${context}`))
    const untracked = (await git('ls-files', '--others', '--exclude-standard')).split('\n').filter(Boolean)
    for (const p of untracked.slice(0, MAX_UNTRACKED)) {
      const [one] = parse(await git('diff', '--no-index', '--no-color', `-U${context}`, '/dev/null', p))
      if (one) files.push({ ...one, path: p, status: 'U' })
    }
    files.sort((a, b) => a.path.localeCompare(b.path))
    out.push({ name: dir.split('/').pop() ?? dir, files })
  }
  await update($, repos, () => out)
}

const short = (p: string, max: number) => (p.length > max ? `...${p.slice(p.length - max + 3)}` : p)
const pad = (v: number | undefined) => (v === undefined ? '' : String(v)).padStart(4)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'repo-diff',
      description: 'Pane with the uncommitted diff of every repo under the working directory',
    })
    return next(e)
  })

  on('command.run', { command: 'repo-diff' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Repo diff' })
    return { text: 'Repo diff pane opened.' }
  })

  // A tool that can change files redraws the diff once it finished.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (['Edit', 'Write', 'NotebookEdit', 'Bash'].includes(e.tool)) await refresh($).catch(() => {})
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const all = await read($, repos)
    const pick = await read($, sel)
    const context = await read($, ctx)
    const cols = e.props?.bodyColumns ?? 60

    if (all.length === 0) return <Text dimColor>No git repository found.</Text>

    const cur = all.find(r => r.name === pick.repo) ?? all[0]
    const idx = Math.max(0, cur.files.findIndex(f => f.path === pick.file))
    const file = cur.files[idx]
    const pickFile = (i: number) => update($, sel, () => ({ repo: cur.name, file: cur.files[i].path }))
    const start = Math.max(0, Math.min(idx - Math.floor(LIST_ROWS / 2), cur.files.length - LIST_ROWS))
    const nextContext = CTX_STEPS[(CTX_STEPS.indexOf(context) + 1) % CTX_STEPS.length]

    return (
      <Box flexDirection="column">
        <Box>
          {all.map(r => (
            <Button
              key={r.name}
              label={`${r.name} ${r.files.length}`}
              variant={r.name === cur.name ? 'primary' : undefined}
              onPress={() => update($, sel, () => ({ repo: r.name, file: '' }))}
            />
          ))}
        </Box>

        {cur.files.length === 0 && <Text dimColor>No changes.</Text>}
        {cur.files.slice(start, start + LIST_ROWS).map((f, i) => (
          <Button key={f.path} plain onPress={() => pickFile(start + i)}>
            <Text color={STATUS_COLOR[f.status]} bold>{f.status}</Text>{' '}
            <Text bold={f === file} inverse={f === file}>{short(f.path, Math.max(10, cols - 14))}</Text>{' '}
            <Text color="green">+{f.add}</Text> <Text color="red">-{f.del}</Text>
          </Button>
        ))}
        {cur.files.length > LIST_ROWS && (
          <Text dimColor>{idx + 1}/{cur.files.length}</Text>
        )}

        {file && (
          <Box flexDirection="column">
            <Box>
              <Button key="prev" label="prev" onPress={() => pickFile(Math.max(0, idx - 1))} />
              <Button key="next" label="next" onPress={() => pickFile(Math.min(cur.files.length - 1, idx + 1))} />
              <Button
                key="ctx"
                label={`context ${context}`}
                onPress={async () => {
                  await update($, ctx, () => nextContext)
                  await refresh($)
                }}
              />
            </Box>
            <Text bold wrap="truncate-start">{file.path}</Text>
            {file.rows.map(r =>
              r.kind === 'hunk' || r.kind === 'note' ? (
                <Text color="cyan" dimColor wrap="truncate">{r.text}</Text>
              ) : (
                <Text
                  backgroundColor={r.kind === 'ctx' ? undefined : BG[r.kind]}
                  color={r.kind === 'add' ? 'green' : r.kind === 'del' ? 'red' : undefined}
                  wrap="truncate"
                >
                  <Text dimColor>{pad(r.old)}{pad(r.neo)} {r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '} </Text>
                  {r.text || ' '}
                </Text>
              ),
            )}
          </Box>
        )}
      </Box>
    )
  })
}

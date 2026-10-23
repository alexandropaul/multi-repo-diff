export type Row = { kind: 'ctx' | 'add' | 'del' | 'hunk' | 'note'; old?: number; neo?: number; text: string }
export type FileDiff = { path: string; status: 'M' | 'A' | 'D' | 'U'; add: number; del: number; rows: Row[] }
export type RepoDiff = { name: string; files: FileDiff[] }
export type Selection = { repo: string; file: string }

declare module 'claude-code' {
  interface PluginState {
    'multi-repo-diff': { repos: RepoDiff[]; sel: Selection; ctx: number }
  }
}

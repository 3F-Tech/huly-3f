//
// Prévia, em texto, da troca de tipo de um projeto — o mesmo de-para que a tela do
// "Trocar tipo de projeto" vai propor, com as contagens reais de tarefas.
//
// Replica a lógica de plugins/tracker-resources/src/utils.ts (buildStatusMigrationPlan):
//   tipo de tarefa : nome → papel compatível ('task'/'subtask'/'both') → posição → primeiro
//   status         : nome → categoria + posição relativa → primeiro status do tipo destino
//
// SÓ LEITURA. Não grava nada. As queries são escopadas ao projeto (nunca varre o workspace).
//
// Uso:
//   npx tsx automation/project-type-preview.ts --project "BOMMA | ESPECIALISTA" --to "Especialistas | Bomma"
//   npx tsx automation/project-type-preview.ts --project BOMMA          # só o retrato atual
//
// Env (automation/.env): HUB_TRANSACTOR_URL, HUB_WORKSPACE_ID, HUB_API_TOKEN
//
import * as dotenv from 'dotenv'
import * as path from 'path'

dotenv.config({ path: path.join(__dirname, '.env') })

const PROJECT_TYPE = 'task:class:ProjectType'
const TASK_TYPE = 'task:class:TaskType'
const STATUS = 'core:class:Status'
const PROJECT = 'tracker:class:Project'
const ISSUE = 'tracker:class:Issue'

const CATEGORY_LABEL: Record<string, string> = {
  'task:statusCategory:UnStarted': 'Backlog',
  'task:statusCategory:ToDo': 'A fazer',
  'task:statusCategory:Active': 'Em andamento',
  'task:statusCategory:Won': 'Concluída',
  'task:statusCategory:Lost': 'Cancelada'
}
const ROLE_LABEL: Record<string, string> = {
  task: 'Tarefa',
  subtask: 'Sub-Tarefa',
  both: 'Tarefa e Sub-Tarefa'
}

async function restFindAll (
  base: string,
  workspace: string,
  token: string,
  _class: string,
  query?: Record<string, any>
): Promise<any[]> {
  const params = new URLSearchParams()
  params.append('class', _class)
  if (query != null && Object.keys(query).length > 0) params.append('query', JSON.stringify(query))
  const endpoint = base.replace(/\/$/, '')
  const res = await fetch(`${endpoint}/api/v1/find-all/${workspace}?${params.toString()}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  })
  if (!res.ok) throw new Error(`find-all ${_class} → HTTP ${res.status} ${res.statusText}`)
  const parsed: any = JSON.parse(await res.text())
  if (parsed?.error != null) throw new Error(`platform error: ${JSON.stringify(parsed.error)}`)
  if (parsed?.dataType === 'TotalArray') return Array.isArray(parsed.value) ? parsed.value : []
  if (Array.isArray(parsed)) return parsed
  return Array.isArray(parsed?.value) ? parsed.value : []
}

function norm (s: string | undefined): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
}

function kindsCompatible (from: string, to: string): boolean {
  return from === to || from === 'both' || to === 'both'
}

function suggestTaskType (from: any, sources: any[], targets: any[]): any {
  if (from == null) return targets[0]
  const byName = targets.find((it) => norm(it.name) === norm(from.name))
  if (byName != null) return byName

  const compatible = targets.filter((it) => kindsCompatible(from.kind, it.kind))
  const pool = compatible.length > 0 ? compatible : targets
  const sameRole = pool.filter((it) => it.kind === from.kind)
  const preferred = sameRole.length > 0 ? sameRole : pool

  const peers = sources.filter((it) => it.kind === from.kind)
  const idx = peers.findIndex((it) => it._id === from._id)
  if (idx >= 0 && idx < preferred.length) return preferred[idx]
  return preferred[0]
}

function suggestStatus (
  from: any,
  sourceDocs: any[],
  targetDocs: any[]
): { to: any, how: 'nome' | 'categoria' | 'fallback' } {
  if (from == null || targetDocs.length === 0) return { to: targetDocs[0], how: 'fallback' }

  const byName = targetDocs.find((it) => norm(it.name) === norm(from.name))
  if (byName != null) return { to: byName, how: 'nome' }

  if (typeof from.category === 'string') {
    const targetSiblings = targetDocs.filter((it) => it.category === from.category)
    if (targetSiblings.length > 0) {
      const sourceSiblings = sourceDocs.filter((it) => it.category === from.category)
      const idx = Math.max(
        0,
        sourceSiblings.findIndex((it) => it._id === from._id)
      )
      return { to: targetSiblings[Math.min(idx, targetSiblings.length - 1)], how: 'categoria' }
    }
  }
  return { to: targetDocs[0], how: 'fallback' }
}

function arg (name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function run (): Promise<void> {
  const { HUB_TRANSACTOR_URL, HUB_WORKSPACE_ID, HUB_API_TOKEN } = process.env
  if (!HUB_API_TOKEN) {
    console.error('❌ HUB_API_TOKEN não configurado (automation/.env)')
    process.exit(1)
  }
  const projectArg = arg('--project')
  const toArg = arg('--to')
  if (projectArg == null) {
    console.error('❌ informe --project "<nome ou identifier>"')
    process.exit(1)
  }

  let workspaceId = HUB_WORKSPACE_ID
  if (!workspaceId) {
    const payload = JSON.parse(Buffer.from(HUB_API_TOKEN.split('.')[1], 'base64').toString())
    workspaceId = payload.workspace
  }
  const url = HUB_TRANSACTOR_URL ?? 'https://3ftasks.3fventure.tech:3332'
  const find = async (cls: string, q?: Record<string, any>): Promise<any[]> =>
    await restFindAll(url, workspaceId!, HUB_API_TOKEN, cls, q)

  const [projects, types, taskTypes, statuses] = await Promise.all([
    find(PROJECT),
    find(PROJECT_TYPE),
    find(TASK_TYPE),
    find(STATUS)
  ])

  const needle = projectArg.toLowerCase()
  const matches = projects.filter(
    (p: any) => (p.name ?? '').toLowerCase().includes(needle) || (p.identifier ?? '').toLowerCase().includes(needle)
  )
  if (matches.length === 0) {
    console.error(`❌ nenhum projeto casa com "${projectArg}"`)
    process.exit(1)
  }
  if (matches.length > 1) {
    console.error(`❌ "${projectArg}" casa com ${matches.length} projetos:`)
    for (const p of matches) console.error(`   • ${p.name} (${p.identifier})`)
    process.exit(1)
  }
  const project = matches[0]

  const typeById = new Map<string, any>(types.map((t: any) => [t._id, t]))
  const ttById = new Map<string, any>(taskTypes.map((t: any) => [t._id, t]))
  const stById = new Map<string, any>(statuses.map((s: any) => [s._id, s]))

  const currentType = typeById.get(project.type)
  const issueTaskTypes = (t: any): any[] => {
    if (t == null) return []
    const ordered = (t.tasks ?? []).map((id: string) => ttById.get(id)).filter((x: any) => x != null)
    for (const tt of taskTypes) {
      if (tt.parent === t._id && !ordered.some((it: any) => it._id === tt._id)) ordered.push(tt)
    }
    return ordered.filter((tt: any) => tt.ofClass === 'tracker:class:Issue')
  }

  // Escopado ao projeto: nunca varre o workspace inteiro.
  const issues = await find(ISSUE, { space: project._id })

  console.log(`\n📋 ${project.name}  (${project.identifier})`)
  console.log(`   tipo atual : ${currentType?.name ?? project.type}  [classic=${currentType?.classic === true}]`)
  console.log(`   tarefas    : ${issues.length}  (inclui subtarefas de qualquer profundidade)\n`)

  const counts = new Map<string, { kind: string, status: string, count: number }>()
  for (const i of issues) {
    const key = `${i.kind}|${i.status}`
    const e = counts.get(key)
    if (e != null) e.count++
    else counts.set(key, { kind: i.kind, status: i.status, count: 1 })
  }

  const sourceTTs = issueTaskTypes(currentType)
  const orderedKinds: string[] = sourceTTs.map((t: any) => t._id)
  for (const { kind } of counts.values()) if (!orderedKinds.includes(kind)) orderedKinds.push(kind)

  const targetType = toArg != null ? types.find((t: any) => (t.name ?? '').toLowerCase().includes(toArg.toLowerCase())) : undefined
  if (toArg != null && targetType == null) {
    console.error(`❌ nenhum tipo de projeto casa com "${toArg}"`)
    process.exit(1)
  }
  const targetTTs = issueTaskTypes(targetType)

  if (targetType != null) {
    console.log(`   ➜ novo tipo: ${targetType.name}  [classic=${targetType.classic === true}]`)
    if ((currentType?.classic === true) && targetType.classic !== true) {
      console.log('   ⚠️  sai de classic para NÃO-classic: o Planner deixa de gerenciar ToDos deste projeto.')
    }
    console.log()
  }

  let needsAttention = 0
  for (const kind of orderedKinds) {
    const entries = Array.from(counts.values()).filter((e) => e.kind === kind)
    if (entries.length === 0) continue
    const srcTT = ttById.get(kind)
    const total = entries.reduce((s, e) => s + e.count, 0)

    const dstTT = targetType != null ? suggestTaskType(srcTT, sourceTTs, targetTTs) : undefined
    const header = `${srcTT?.name ?? kind} [${ROLE_LABEL[srcTT?.kind] ?? '?'}]  ·  ${total} tarefa(s)`
    console.log('─'.repeat(78))
    console.log(dstTT != null ? `${header}  →  ${dstTT.name} [${ROLE_LABEL[dstTT.kind]}]` : header)

    const srcStatuses = ((srcTT?.statuses ?? []) as string[]).map((id) => stById.get(id)).filter((x: any) => x != null)
    const dstStatuses = dstTT != null ? ((dstTT.statuses ?? []) as string[]).map((id) => stById.get(id)).filter((x: any) => x != null) : []

    const ordered = [...entries].sort((a, b) => {
      const ia = (srcTT?.statuses ?? []).indexOf(a.status)
      const ib = (srcTT?.statuses ?? []).indexOf(b.status)
      return (ia === -1 ? 1e9 : ia) - (ib === -1 ? 1e9 : ib)
    })

    for (const e of ordered) {
      const from = stById.get(e.status)
      const fromCat = typeof from?.category === 'string' ? (CATEGORY_LABEL[from.category] ?? from.category) : '?'
      const left = `  ${String(from?.name ?? e.status).padEnd(26)} ${String(e.count).padStart(4)}  (${fromCat})`
      if (dstTT == null) {
        console.log(left)
        continue
      }
      const { to, how } = suggestStatus(from, srcStatuses, dstStatuses)
      const flag = how === 'nome' ? '✅' : '⚠️ '
      if (how !== 'nome') needsAttention += e.count
      console.log(`${left}  →  ${flag} ${String(to?.name ?? '?').padEnd(24)} [${how}]`)
    }
  }

  console.log('─'.repeat(78))
  if (targetType != null) {
    console.log(`✅ casou por nome = mantém o estágio.  ⚠️  = caiu na categoria/fallback: CONFIRA na tela.`)
    console.log(`   ${needsAttention} tarefa(s) em linhas marcadas com ⚠️ .`)
  }
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})

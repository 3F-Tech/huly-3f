//
// Inventário dos tipos de projeto (ProjectType) do workspace.
//
// Responde três perguntas que a UI não mostra:
//   • o tipo é `classic`? (o toggle "Projeto clássico" só aparece na CRIAÇÃO do tipo, e é
//     ele que liga/desliga toda a automação de ToDo do Planner — ver server-plugins/
//     time-resources: todo handler começa com `if (!type?.classic) return []`);
//   • quais tipos de TAREFA ele tem, e o papel de cada um ('task' | 'subtask' | 'both');
//   • quais status cada tipo de tarefa tem, e em que categoria.
//
// Útil antes de trocar o tipo de um projeto: é o mesmo de-para que a tela mostra, em texto.
//
// SÓ LEITURA. Não grava nada.
//
// Uso:
//   npx tsx automation/list-project-types.ts                 # todos os tipos
//   npx tsx automation/list-project-types.ts --projects      # + quais projetos usam cada tipo
//   npx tsx automation/list-project-types.ts --name Bomma    # filtra por nome do tipo
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

// Read cru no endpoint REST — o wrapper findAll do api-client local quebra quando o transactor
// devolve lookupMap:null (skew de versão), e status malformados derrubam findAll(IssueStatus).
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

async function run (): Promise<void> {
  const { HUB_TRANSACTOR_URL, HUB_WORKSPACE_ID, HUB_API_TOKEN } = process.env
  if (!HUB_API_TOKEN) {
    console.error('❌ HUB_API_TOKEN não configurado (automation/.env)')
    process.exit(1)
  }

  const withProjects = process.argv.includes('--projects')
  const nameIdx = process.argv.indexOf('--name')
  const nameFilter = nameIdx >= 0 ? (process.argv[nameIdx + 1] ?? '').toLowerCase() : undefined

  let workspaceId = HUB_WORKSPACE_ID
  if (!workspaceId) {
    const payload = JSON.parse(Buffer.from(HUB_API_TOKEN.split('.')[1], 'base64').toString())
    workspaceId = payload.workspace
  }
  const url = HUB_TRANSACTOR_URL ?? 'https://3ftasks.3fventure.tech:3332'

  const [types, taskTypes, statuses, projects] = await Promise.all([
    restFindAll(url, workspaceId!, HUB_API_TOKEN, PROJECT_TYPE),
    restFindAll(url, workspaceId!, HUB_API_TOKEN, TASK_TYPE),
    restFindAll(url, workspaceId!, HUB_API_TOKEN, STATUS),
    withProjects ? restFindAll(url, workspaceId!, HUB_API_TOKEN, PROJECT) : Promise.resolve([])
  ])

  const statusById = new Map<string, any>(statuses.map((s: any) => [s._id, s]))
  const taskTypeById = new Map<string, any>(taskTypes.map((t: any) => [t._id, t]))

  // Contagem de tarefas por projeto, só quando pedido (uma query por projeto seria N+1).
  const issueCountBySpace = new Map<string, number>()
  if (withProjects) {
    const issues = await restFindAll(url, workspaceId!, HUB_API_TOKEN, ISSUE)
    for (const i of issues) {
      issueCountBySpace.set(i.space, (issueCountBySpace.get(i.space) ?? 0) + 1)
    }
  }

  const shown = types.filter((t: any) => nameFilter === undefined || (t.name ?? '').toLowerCase().includes(nameFilter))

  console.log(`\n📁 Tipos de projeto (${shown.length} de ${types.length})\n`)

  for (const type of shown) {
    const classic = type.classic === true
    console.log('═'.repeat(78))
    console.log(`${type.name}`)
    console.log(`  _id      : ${type._id}`)
    console.log(`  classic  : ${classic ? '✅ SIM — Planner (ToDo) ATIVO' : '❌ NÃO — Planner (ToDo) DESLIGADO'}`)
    if (type.description) console.log(`  descrição: ${type.description}`)

    const tts = (type.tasks ?? []).map((id: string) => taskTypeById.get(id)).filter((t: any) => t != null)
    const extras = taskTypes.filter((t: any) => t.parent === type._id && !(type.tasks ?? []).includes(t._id))
    const all = [...tts, ...extras]

    console.log(`  tipos de tarefa (${all.length}):`)
    for (const tt of all) {
      const role = ROLE_LABEL[tt.kind] ?? tt.kind
      console.log(`    • ${tt.name}  [${role}]  ofClass=${tt.ofClass}`)
      const ids: string[] = tt.statuses ?? []
      for (const sid of ids) {
        const s = statusById.get(sid)
        if (s == null) {
          console.log(`        ⚠️  status ${sid} não encontrado`)
          continue
        }
        const cat = typeof s.category === 'string' ? (CATEGORY_LABEL[s.category] ?? s.category) : `⚠️ ${JSON.stringify(s.category)}`
        console.log(`        - ${String(s.name).padEnd(28)} (${cat})`)
      }
    }

    if (withProjects) {
      const mine = projects.filter((p: any) => p.type === type._id)
      if (mine.length > 0) {
        console.log(`  projetos usando este tipo (${mine.length}):`)
        for (const p of mine) {
          const n = issueCountBySpace.get(p._id) ?? 0
          console.log(`    • ${String(p.name).padEnd(36)} ${p.identifier ?? ''}  ${n} tarefa(s)`)
        }
      }
    }
    console.log()
  }

  console.log('═'.repeat(78))
  console.log('Lembrete: `classic` só é definido na CRIAÇÃO do tipo de projeto; não há toggle')
  console.log('para alterá-lo depois na interface. É ele que liga a automação de ToDo do Planner.')
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})

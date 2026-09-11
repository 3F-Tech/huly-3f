<!--
// Copyright © 2026 Hardcore Engineering Inc.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
-->
<script lang="ts">
  import { type Ref } from '@hcengineering/core'
  import { getEmbeddedLabel, type IntlString } from '@hcengineering/platform'
  import { Card, getClient } from '@hcengineering/presentation'
  import { type ProjectType, type TaskType, type TaskTypeKind } from '@hcengineering/task'
  import { taskTypeStore, typeStore } from '@hcengineering/task-resources'
  import { type IssueStatus, type Project } from '@hcengineering/tracker'
  import { ButtonMenu, IconArrowRight, Label, Spinner } from '@hcengineering/ui'
  import { statusStore } from '@hcengineering/view-resources'

  import tracker from '../../plugin'
  import {
    buildStatusMigrationPlan,
    changeProjectType,
    estimateMigrationMinutes,
    statusMigrationKey,
    suggestRowTarget,
    type StatusMigrationGroup,
    type StatusMigrationMapping,
    type StatusMigrationPlan
  } from '../../utils'
  import StatusPresenter from '../issues/StatusPresenter.svelte'
  import StatusSelector from '../issues/StatusSelector.svelte'

  export let project: Project
  export let newTypeId: Ref<ProjectType>
  export let preferredInitial: Ref<IssueStatus> | undefined = undefined
  // Gravação dos demais campos do formulário, executada depois da migração.
  export let afterMigrate: (() => Promise<void>) | undefined = undefined

  const client = getClient()

  let plan: StatusMigrationPlan | undefined = undefined
  let groups: StatusMigrationGroup[] = []
  let mapping: StatusMigrationMapping = new Map()
  let loading: boolean = true
  let migrating: boolean = false
  let done: number = 0
  let toMigrate: number = 0
  let error: string | undefined = undefined

  $: currentTypeName = $typeStore.get(project.type)?.name ?? ''
  $: newTypeName = $typeStore.get(newTypeId)?.name ?? ''
  // Mais de um tipo de tarefa em qualquer um dos lados: o seletor de tipo destino é relevante.
  $: showTaskTypes = groups.length > 1 || (plan?.targetTaskTypes.length ?? 0) > 1
  $: taskTypeItems = (plan?.targetTaskTypes ?? []).map((tt) => ({ id: tt._id, label: getEmbeddedLabel(tt.name) }))
  $: estimatedMinutes = estimateMigrationMinutes(plan?.total ?? 0)

  void load()

  async function load (): Promise<void> {
    try {
      plan = await buildStatusMigrationPlan(client, project, newTypeId, preferredInitial)
      groups = plan.groups
      rebuildMapping()
    } catch (err: any) {
      error = err?.message ?? String(err)
    } finally {
      loading = false
    }
  }

  function rebuildMapping (): void {
    const next: StatusMigrationMapping = new Map()
    for (const group of groups) {
      for (const row of group.rows) {
        next.set(statusMigrationKey(row.fromKind, row.from), { kind: row.toKind, status: row.to })
      }
    }
    mapping = next
  }

  function setRowTarget (group: StatusMigrationGroup, from: Ref<IssueStatus>, to: Ref<IssueStatus>): void {
    const row = group.rows.find((it) => it.from === from)
    if (row === undefined) return
    row.to = to
    groups = groups
    rebuildMapping()
  }

  /** Trocar o tipo de tarefa destino de um grupo re-sugere os status dele, que pertencem a outro tipo. */
  function setGroupTaskType (group: StatusMigrationGroup, toKind: Ref<TaskType>): void {
    if (plan === undefined || group.toKind === toKind) return
    const sourceTaskType = $taskTypeStore.get(group.fromKind)
    group.toKind = toKind
    for (const row of group.rows) {
      row.toKind = toKind
      const suggestion = suggestRowTarget(
        row.from,
        sourceTaskType,
        toKind,
        plan.statusesByTaskType,
        $statusStore.byId,
        plan.initial
      )
      row.to = suggestion.to
      row.suggestedBy = suggestion.suggestedBy
    }
    groups = groups
    rebuildMapping()
  }

  function statusOf (id: Ref<IssueStatus>): IssueStatus | undefined {
    return $statusStore.byId.get(id) as IssueStatus | undefined
  }

  /** Papel do tipo de tarefa: o "Tarefa / Sub-Tarefa / Tarefa e Sub-Tarefa" da configuração do tipo. */
  function roleLabel (kind: TaskTypeKind | undefined): IntlString | undefined {
    if (kind === 'task') return tracker.string.ChangeProjectTypeRoleTask
    if (kind === 'subtask') return tracker.string.ChangeProjectTypeRoleSubTask
    if (kind === 'both') return tracker.string.ChangeProjectTypeRoleBoth
    return undefined
  }

  /** Um tipo 'task' não deve virar 'subtask' e vice-versa; 'both' serve para os dois. */
  function roleMismatch (from: TaskTypeKind | undefined, to: TaskTypeKind | undefined): boolean {
    if (from === undefined || to === undefined) return false
    return from !== to && from !== 'both' && to !== 'both'
  }

  async function migrate (): Promise<void> {
    if (plan === undefined || migrating) {
      return
    }
    migrating = true
    try {
      await changeProjectType(client, project, newTypeId, {
        mapping,
        preferredInitial,
        onProgress: (d, total) => {
          done = d
          toMigrate = total
        }
      })
      await afterMigrate?.()
    } catch (err: any) {
      error = err?.message ?? String(err)
    } finally {
      migrating = false
    }
  }
</script>

<Card
  label={tracker.string.ChangeProjectType}
  okLabel={tracker.string.ChangeProjectTypeConfirmButton}
  okAction={migrate}
  canSave={!loading && !migrating && error === undefined && plan !== undefined}
  width={'medium'}
  hideClose={migrating}
  on:close
  on:changeContent
>
  <svelte:fragment slot="header">
    <span class="fs-title overflow-label">
      {currentTypeName} → {newTypeName}
    </span>
  </svelte:fragment>

  {#if loading}
    <div class="flex-center pt-4 pb-4">
      <Spinner size={'medium'} />
    </div>
  {:else if error !== undefined}
    <div class="pt-2 pb-2 error-color">{error}</div>
  {:else if plan !== undefined}
    <div class="mb-2">
      <Label label={tracker.string.ChangeProjectTypeIntro} params={{ count: plan.total }} />
    </div>
    {#if plan.total > 0}
      <div class="mb-4 content-dark-color text-sm">
        <Label label={tracker.string.ChangeProjectTypeEstimate} params={{ minutes: estimatedMinutes }} />
      </div>
    {/if}

    {#if groups.length === 0}
      <div class="mb-4">
        <Label label={tracker.string.ChangeProjectTypeNoTasks} />
      </div>
    {:else}
      {#each groups as group (group.fromKind)}
        {#if showTaskTypes}
          {@const fromRole = $taskTypeStore.get(group.fromKind)?.kind}
          {@const toRole = $taskTypeStore.get(group.toKind)?.kind}
          <div class="group-header mt-3 mb-2">
            <div class="flex-row-center">
              <span class="fs-title mr-2">{group.fromKindName}</span>
              {#if roleLabel(fromRole) !== undefined}
                <span class="content-dark-color text-sm mr-2">(<Label label={roleLabel(fromRole)} />)</span>
              {/if}
              <span class="content-dark-color text-sm mr-2">
                <Label label={tracker.string.ChangeProjectTypeTaskCount} params={{ count: group.count }} />
              </span>
              <IconArrowRight size={'small'} />
              <div class="ml-2 mr-2">
                <ButtonMenu
                  items={taskTypeItems}
                  selected={group.toKind}
                  label={getEmbeddedLabel($taskTypeStore.get(group.toKind)?.name ?? '')}
                  kind={'secondary'}
                  size={'small'}
                  on:selected={(e) => {
                    setGroupTaskType(group, e.detail)
                  }}
                />
              </div>
              {#if roleLabel(toRole) !== undefined}
                <span class="content-dark-color text-sm">(<Label label={roleLabel(toRole)} />)</span>
              {/if}
            </div>
            {#if roleMismatch(fromRole, toRole)}
              <div class="role-mismatch text-sm mt-1">
                <Label label={tracker.string.ChangeProjectTypeRoleMismatch} />
              </div>
            {/if}
          </div>
        {/if}

        <div class="header mb-1">
          <span class="fs-title"><Label label={tracker.string.ChangeProjectTypeFrom} /></span>
          <span />
          <span class="fs-title"><Label label={tracker.string.ChangeProjectTypeTo} /></span>
        </div>

        {#each group.rows as row (row.from)}
          <div class="mapping-row">
            <div class="from flex-row-center">
              <StatusPresenter
                value={statusOf(row.from)}
                space={project._id}
                projectType={project.type}
                taskType={row.fromKind}
              />
              <span class="ml-2 content-dark-color text-sm">
                <Label label={tracker.string.ChangeProjectTypeTaskCount} params={{ count: row.count }} />
              </span>
            </div>
            <div class="arrow flex-center">
              <IconArrowRight size={'small'} />
            </div>
            <div class="to">
              <StatusSelector
                value={row.to}
                type={newTypeId}
                taskType={row.toKind}
                kind={'regular'}
                size={'medium'}
                width={'100%'}
                on:change={(e) => {
                  setRowTarget(group, row.from, e.detail)
                }}
              />
            </div>
          </div>
        {/each}
      {/each}
    {/if}

    <div class="mt-4 content-dark-color text-sm">
      <Label label={tracker.string.ChangeProjectTypeRolesWarning} />
    </div>

    {#if migrating}
      <div class="mt-2 flex-row-center">
        <Spinner size={'small'} />
        <span class="ml-2">
          <Label label={tracker.string.ChangeProjectTypeProgress} params={{ done, total: toMigrate }} />
        </span>
      </div>
    {/if}
  {/if}
</Card>

<style lang="scss">
  .mapping-row {
    display: grid;
    grid-template-columns: 1fr 1.5rem minmax(10rem, 1fr);
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0;
    border-bottom: 1px solid var(--theme-divider-color);

    &:last-child {
      border-bottom: none;
    }
  }

  .header {
    display: grid;
    grid-template-columns: 1fr 1.5rem minmax(10rem, 1fr);
    gap: 0.5rem;
  }

  /* Não existe classe utilitária .warning-color no tema (só a variável); define aqui. */
  .role-mismatch {
    color: var(--theme-warning-color);
  }

  .group-header {
    border-top: 1px solid var(--theme-divider-color);
    padding-top: 0.5rem;
  }

  .from {
    min-width: 0;
  }
</style>

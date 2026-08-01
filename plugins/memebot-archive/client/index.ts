import { Context, send } from '@koishijs/client'
import { defineComponent, h, onMounted, ref } from 'vue'

interface Paper { id: string; title: string; issueNumber: string; month: string; description?: string; sourceLink?: string; backupState?: string; attachment?: { relativePath: string; size: number; checksum: string } }
interface Work { id: string; title: string; author: string; description?: string; backupState?: string; attachment?: { relativePath: string; size: number; checksum: string } }
interface RemovedRecord { kind: 'paper' | 'work'; id: string; title: string; author?: string; lifecycle: 'removed' | 'purged'; removedAt: string; expiresAt: string; purgedAt?: string }
interface RetiredAttachment { id: string; recordKind: 'paper' | 'work'; recordId: string; attachment: { relativePath: string; size: number; checksum: string }; removedAt: string; expiresAt: string }
interface LifecycleAudit { id: string; actor: string; recordId: string; action: string; details: string; createdAt: string }
interface AppearanceWork { work: Work; page?: string; section?: string; displayOrder: number }
interface AppearancePaper { paper: Paper; page?: string; section?: string; displayOrder: number }
interface RestoreEntry { recordKind: 'paper' | 'work'; recordId: string; status: 'new' | 'unchanged' | 'changed' | 'conflicting'; missingAttachment: boolean; local?: Paper | Work; remote: Paper | Work }
interface RestorePreview { counts: { new: number; changed: number; conflicting: number; missing: number }; entries: RestoreEntry[] }
interface RestoreAudit { id: string; actor: string; action: string; result: string; details: string; createdAt: string }
interface TreeEntry { path: string; size: number; previewable: boolean; kind: string }
interface Health { state: 'ready' | 'degraded' | 'unavailable'; lastCheck: string; stores: { local: { ok: boolean; error?: string }; r2: { enabled: boolean; ok?: boolean; error?: string } }; queue: { pending: number; failed: number; complete: number } }

const ArchivePage = defineComponent({
  name: 'MemebotArchive',
  setup() {
    const tab = ref<'paper' | 'work'>('paper')
    const health = ref<Health>()
    const papers = ref<Paper[]>([]); const works = ref<Work[]>([]); const query = ref('')
    const title = ref(''); const issueNumber = ref(''); const month = ref(''); const author = ref(''); const description = ref(''); const sourceLink = ref('')
    const file = ref<File>(); const paperPreview = ref(''); const tree = ref<TreeEntry[]>([]); const selectedPaper = ref<{ paper: Paper; works: AppearanceWork[] }>(); const selectedWork = ref<Work>(); const workPapers = ref<AppearancePaper[]>([]); const workPreview = ref<any>(); const error = ref('')
    const restorePreview = ref<RestorePreview>(); const restoreHistory = ref<RestoreAudit[]>([]); const restoreChoices = ref<Record<string, 'local' | 'r2'>>({})
    const removed = ref<RemovedRecord[]>([]); const retired = ref<RetiredAttachment[]>([]); const lifecycleHistory = ref<LifecycleAudit[]>([])

    const loadStatus = async () => { try { health.value = await send('memebot/archive/status') as Health } catch (cause) { error.value = String(cause) } }
    const load = async () => {
      try {
        if (tab.value === 'paper') papers.value = await send('memebot/archive/papers', query.value) as Paper[]
        else works.value = await send('memebot/archive/works', query.value) as Work[]
        error.value = ''
      } catch (cause) { error.value = String(cause) }
    }
    const asDataUrl = (value: File) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(value) })
    const reset = () => { title.value = issueNumber.value = month.value = author.value = description.value = sourceLink.value = ''; file.value = undefined }
    const create = async () => {
      if (!file.value) { error.value = `请选择一个 ${tab.value === 'paper' ? 'PDF' : 'ZIP'}。`; return }
      try {
        const attachment = { filename: file.value.name, contentType: file.value.type || (tab.value === 'paper' ? 'application/pdf' : 'application/zip'), data: await asDataUrl(file.value) }
        if (tab.value === 'paper') await send('memebot/archive/paper/create', { title: title.value, issueNumber: issueNumber.value, month: month.value, description: description.value, sourceLink: sourceLink.value, attachment })
        else await send('memebot/archive/work/create', { title: title.value, author: author.value, description: description.value, attachment })
        reset(); await load(); await loadStatus()
      } catch (cause) { error.value = String(cause) }
    }
    const downloadData = (result: { filename: string; contentType?: string; data: string }) => { const anchor = document.createElement('a'); anchor.href = `data:${result.contentType || 'application/octet-stream'};base64,${result.data}`; anchor.download = result.filename; anchor.click() }
    const paperAttachment = async (paper: Paper, download: boolean) => {
      try { const result = await send(download ? 'memebot/archive/paper/download' : 'memebot/archive/paper/preview', paper.id) as { filename: string; contentType: string; data: string }; if (download) downloadData(result); else paperPreview.value = `data:${result.contentType};base64,${result.data}` } catch (cause) { error.value = String(cause) }
    }
    const editPaper = async (paper: Paper) => {
      const values = [window.prompt('Paper 标题', paper.title), window.prompt('期号', paper.issueNumber), window.prompt('月份（YYYY-MM）', paper.month), window.prompt('描述', paper.description ?? ''), window.prompt('来源链接', paper.sourceLink ?? '')]
      if (values.some(value => value == null)) return
      try { await send('memebot/archive/paper/edit', paper.id, { title: values[0], issueNumber: values[1], month: values[2], description: values[3], sourceLink: values[4] }); await load() } catch (cause) { error.value = String(cause) }
    }
    const editWork = async (work: Work) => {
      const nextTitle = window.prompt('Work 标题', work.title); if (nextTitle == null) return
      const nextAuthor = window.prompt('作者', work.author); if (nextAuthor == null) return
      const nextDescription = window.prompt('描述', work.description ?? ''); if (nextDescription == null) return
      try { await send('memebot/archive/work/edit', work.id, { title: nextTitle, author: nextAuthor, description: nextDescription }); await load() } catch (cause) { error.value = String(cause) }
    }
    const inspectPaper = async (paper: Paper) => { try { selectedPaper.value = await send('memebot/archive/paper/details', paper.id) as any } catch (cause) { error.value = String(cause) } }
    const associateExisting = async (paper: Paper) => {
      const workId = window.prompt('Work 编号（例如 W1）'); if (!workId) return
      const page = window.prompt('页码（可选）', '') ?? ''; const section = window.prompt('栏目（可选）', '') ?? ''; const order = window.prompt('显示顺序（可选）', '') ?? ''
      try { await send('memebot/archive/appearance/save', paper.id, { workId, page, section, ...(order && { displayOrder: Number(order) }) }); await inspectPaper(paper); await load() } catch (cause) { error.value = String(cause) }
    }
    const createAssociatedWork = async (paper: Paper) => {
      const workTitle = window.prompt('新 Work 标题'); if (!workTitle) return
      const workAuthor = window.prompt('作者'); if (!workAuthor) return
      const workDescription = window.prompt('描述（可选）', '') ?? ''; const page = window.prompt('页码（可选）', '') ?? ''; const section = window.prompt('栏目（可选）', '') ?? ''
      const picker = document.createElement('input'); picker.type = 'file'; picker.accept = '.zip,application/zip'
      picker.onchange = async () => {
        const selected = picker.files?.[0]; if (!selected) return
        try {
          await send('memebot/archive/appearance/save', paper.id, { page, section, work: { title: workTitle, author: workAuthor, description: workDescription, attachment: { filename: selected.name, contentType: selected.type || 'application/zip', data: await asDataUrl(selected) } } })
          await inspectPaper(paper); await load(); await loadStatus()
        } catch (cause) { error.value = String(cause) }
      }
      picker.click()
    }
    const removeAppearance = async (paper: Paper, workId: string) => { try { await send('memebot/archive/appearance/remove', paper.id, workId); await inspectPaper(paper); await load() } catch (cause) { error.value = String(cause) } }
    const upload = async (kind: 'paper' | 'work', id: string, next?: File) => {
      if (!next) return
      try { await send(`memebot/archive/${kind}/upload`, id, { filename: next.name, contentType: next.type || (kind === 'paper' ? 'application/pdf' : 'application/zip'), data: await asDataUrl(next) }); await load(); await loadStatus() } catch (cause) { error.value = String(cause) }
    }
    const inspectWork = async (work: Work) => { try { selectedWork.value = work; tree.value = await send('memebot/archive/work/tree', work.id) as TreeEntry[]; workPapers.value = ((await send('memebot/archive/work/details', work.id) as any)?.papers ?? []); workPreview.value = undefined } catch (cause) { error.value = String(cause) } }
    const previewFile = async (entry: TreeEntry) => { if (!selectedWork.value) return; try { workPreview.value = { entry, result: await send('memebot/archive/work/preview', selectedWork.value.id, entry.path) } } catch (cause) { error.value = String(cause) } }
    const downloadWork = async (work: Work) => { try { downloadData(await send('memebot/archive/work/download', work.id) as any) } catch (cause) { error.value = String(cause) } }
    const downloadTreeFile = async (entry: TreeEntry) => { if (!selectedWork.value) return; try { downloadData({ ...(await send('memebot/archive/work/file', selectedWork.value.id, entry.path) as any), contentType: 'application/octet-stream' }) } catch (cause) { error.value = String(cause) } }
    const recheck = async () => { try { await send('memebot/archive/recheck'); await loadStatus() } catch (cause) { error.value = String(cause) } }
    const retry = async () => { try { await send('memebot/archive/backup/retry'); await loadStatus(); await load() } catch (cause) { error.value = String(cause) } }
    const checkRestore = async () => { try { restorePreview.value = await send('memebot/archive/restore/preview') as RestorePreview; restoreHistory.value = await send('memebot/archive/restore/history') as RestoreAudit[] } catch (cause) { error.value = String(cause) } }
    const applyRestore = async () => {
      try {
        const selections = Object.entries(restoreChoices.value).map(([key, decision]) => { const [recordKind, recordId] = key.split(':'); return { recordKind, recordId, decision } })
        await send('memebot/archive/restore/apply', selections); restoreChoices.value = {}; await Promise.all([checkRestore(), load(), loadStatus()])
      } catch (cause) { error.value = String(cause); await checkRestore() }
    }
    const loadLifecycle = async () => {
      try {
        [removed.value, retired.value, lifecycleHistory.value] = await Promise.all([
          send('memebot/archive/removed') as Promise<RemovedRecord[]>,
          send('memebot/archive/attachments/retired') as Promise<RetiredAttachment[]>,
          send('memebot/archive/lifecycle/history') as Promise<LifecycleAudit[]>,
        ])
      } catch (cause) { error.value = String(cause) }
    }
    const removeRecord = async (record: Paper | Work, kind: 'paper' | 'work') => {
      const target = kind === 'paper' ? `${record.id} ${(record as Paper).month} ${(record as Paper).title}` : `${record.id} ${(record as Work).author} - ${record.title}`
      if (!window.confirm(`确认移除 ${target}？记录与附件将立即对普通用户隐藏，并保留 30 天。`)) return
      try { await send('memebot/archive/record/remove', record.id, 'Y'); await Promise.all([load(), loadLifecycle()]) } catch (cause) { error.value = String(cause) }
    }
    const restoreRecord = async (record: RemovedRecord) => {
      if (!window.confirm(`恢复 ${record.id} ${record.title} 及其原 Publication Appearances？`)) return
      try { await send('memebot/archive/record/restore', record.id); await Promise.all([load(), loadLifecycle()]) } catch (cause) { error.value = String(cause) }
    }
    const purgeRecord = async (record: RemovedRecord) => {
      if (window.prompt(`永久清理 ${record.id} 的本地与 R2 附件。请输入编号 ${record.id} 确认。`) !== record.id) return
      try { await send('memebot/archive/record/purge', record.id, 'Y'); await loadLifecycle() } catch (cause) { error.value = String(cause) }
    }
    const anonymizeRecord = async (record: RemovedRecord) => {
      if (window.prompt(`匿名化 ${record.id} 的身份字段与描述。请输入编号 ${record.id} 确认。`) !== record.id) return
      try { await send('memebot/archive/record/anonymize', record.id, 'Y'); await loadLifecycle() } catch (cause) { error.value = String(cause) }
    }
    const restoreAttachment = async (item: RetiredAttachment) => {
      if (!window.confirm(`将 ${item.recordId} 恢复到附件版本 ${item.attachment.relativePath}？当前版本也会保留 30 天。`)) return
      try { await send('memebot/archive/attachment/restore', item.id); await Promise.all([load(), loadLifecycle()]) } catch (cause) { error.value = String(cause) }
    }

    onMounted(async () => { await Promise.all([load(), loadStatus(), loadLifecycle()]) })
    const input = (label: string, value: typeof title, type = 'text') => h('label', { style: 'display:grid;gap:4px' }, [label, h('input', { type, value: value.value, onInput: (event: Event) => value.value = (event.target as HTMLInputElement).value })])
    const status = () => health.value && h('section', { style: 'padding:12px;border:1px solid #ddd;border-radius:8px' }, [
      h('strong', `存储状态：${health.value.state}`), h('span', ` · 本地 ${health.value.stores.local.ok ? '正常' : health.value.stores.local.error}`), h('span', ` · R2 ${health.value.stores.r2.enabled ? health.value.stores.r2.ok ? '正常' : health.value.stores.r2.error : '未启用'}`),
      h('span', ` · 队列 待处理 ${health.value.queue.pending} / 失败 ${health.value.queue.failed} / 完成 ${health.value.queue.complete}`),
      h('button', { style: 'margin-left:8px', onClick: recheck }, '重新预检'), h('button', { style: 'margin-left:8px', onClick: retry }, '立即重试备份'),
    ])
    const previewNode = () => {
      if (!workPreview.value) return null
      const { entry, result } = workPreview.value
      if (!result.previewable) return h('p', ['该文件不可预览。', h('button', { onClick: () => downloadTreeFile(entry) }, '下载')])
      if (result.kind === 'text') return h('pre', { style: 'white-space:pre-wrap;max-height:60vh;overflow:auto' }, result.text)
      if (result.kind === 'web') { const url = URL.createObjectURL(new Blob([result.text], { type: result.contentType })); return h('iframe', { src: url, sandbox: 'allow-downloads', style: 'width:100%;height:60vh;border:1px solid #ddd' }) }
      const url = `data:${result.contentType};base64,${result.data}`
      if (result.kind === 'image') return h('img', { src: url, style: 'max-width:100%;max-height:60vh' })
      if (result.kind === 'audio') return h('audio', { src: url, controls: true })
      if (result.kind === 'video') return h('video', { src: url, controls: true, style: 'max-width:100%;max-height:60vh' })
      return h('iframe', { src: url, sandbox: 'allow-downloads', style: 'width:100%;height:60vh;border:1px solid #ddd' })
    }
    const restoreNode = () => h('section', { style: 'padding:12px;border:1px solid #ddd;border-radius:8px;display:grid;gap:8px' }, [
      h('h2', 'R2 清单恢复'), h('div', [h('button', { onClick: checkRestore }, '检查 R2 清单'), restorePreview.value && h('button', { style: 'margin-left:8px', onClick: applyRestore }, '执行安全恢复')]),
      restorePreview.value && h('p', `新增 ${restorePreview.value.counts.new} · 变化 ${restorePreview.value.counts.changed} · 冲突 ${restorePreview.value.counts.conflicting} · 缺失附件 ${restorePreview.value.counts.missing}`),
      restorePreview.value && h('ul', restorePreview.value.entries.map(entry => {
        const key = `${entry.recordKind}:${entry.recordId}`
        return h('li', { key }, [`${entry.recordId} ${entry.status}${entry.missingAttachment ? ' · 本地附件缺失' : ''} `,
          ['changed', 'conflicting'].includes(entry.status) && h('details', { style: 'margin:4px 0' }, [h('summary', '比较本地与 R2 元数据'), h('pre', { style: 'white-space:pre-wrap' }, `本地：${JSON.stringify(entry.local, null, 2)}\nR2：${JSON.stringify(entry.remote, null, 2)}`)]),
          entry.status === 'conflicting' && h('span', [h('button', { onClick: () => restoreChoices.value = { ...restoreChoices.value, [key]: 'local' } }, '保留本地'), h('button', { onClick: () => restoreChoices.value = { ...restoreChoices.value, [key]: 'r2' } }, '采用 R2'), ` 当前：${restoreChoices.value[key] ?? '保留本地'}`]),
        ])
      })),
      restoreHistory.value.length > 0 && h('details', [h('summary', '恢复审计记录'), h('ul', restoreHistory.value.map(item => h('li', { key: item.id }, `${item.createdAt} ${item.actor} ${item.result}: ${item.details}`)))]),
    ])
    const lifecycleNode = () => h('section', { style: 'padding:12px;border:1px solid #ddd;border-radius:8px;display:grid;gap:8px' }, [
      h('h2', '移除与恢复'),
      removed.value.length ? h('table', { style: 'width:100%' }, [h('tbody', removed.value.map(record => h('tr', { key: record.id }, [
        h('td', `${record.id} ${record.title}${record.author ? ` · ${record.author}` : ''}`),
        h('td', record.lifecycle === 'removed' ? `删除：${record.removedAt} · 到期：${record.expiresAt}` : `已永久清理：${record.purgedAt}`),
        h('td', [record.lifecycle === 'removed' && h('button', { onClick: () => restoreRecord(record) }, '恢复'), record.lifecycle === 'removed' && h('button', { onClick: () => purgeRecord(record) }, '永久清理'), h('button', { onClick: () => anonymizeRecord(record) }, '匿名化')]),
      ])))]) : h('p', '没有已移除记录。'),
      retired.value.length > 0 && h('details', [h('summary', `可恢复的旧附件版本（${retired.value.length}）`), h('ul', retired.value.map(item => h('li', { key: item.id }, [`${item.recordId} ${item.attachment.relativePath} · 到期 ${item.expiresAt} `, h('button', { onClick: () => restoreAttachment(item) }, '恢复此版本')])))]),
      lifecycleHistory.value.length > 0 && h('details', [h('summary', '生命周期审计'), h('ul', lifecycleHistory.value.map(item => h('li', { key: item.id }, `${item.createdAt} ${item.actor} ${item.action} ${item.recordId}`)))]),
    ])
    return () => h('main', { style: 'padding:24px;display:grid;gap:20px' }, [
      h('h1', 'Archive 归档'), status(), lifecycleNode(), restoreNode(), error.value && h('p', { style: 'color:#c33' }, error.value),
      h('nav', { style: 'display:flex;gap:8px' }, [h('button', { disabled: tab.value === 'paper', onClick: async () => { tab.value = 'paper'; query.value = ''; await load() } }, 'Paper'), h('button', { disabled: tab.value === 'work', onClick: async () => { tab.value = 'work'; query.value = ''; await load() } }, 'Work')]),
      h('section', { style: 'display:flex;gap:8px' }, [h('input', { placeholder: tab.value === 'paper' ? '月份、期号、标题或描述' : '标题、作者或描述', value: query.value, onInput: (event: Event) => query.value = (event.target as HTMLInputElement).value }), h('button', { onClick: load }, '搜索')]),
      h('section', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px' }, [
        input('标题', title), ...(tab.value === 'paper' ? [input('期号', issueNumber), input('月份（YYYY-MM）', month), input('来源链接', sourceLink, 'url')] : [input('作者', author)]), input('描述', description),
        h('label', { style: 'display:grid;gap:4px' }, [tab.value === 'paper' ? 'PDF' : 'ZIP Work Package', h('input', { type: 'file', accept: tab.value === 'paper' ? 'application/pdf,.pdf' : 'application/zip,.zip', onChange: (event: Event) => file.value = (event.target as HTMLInputElement).files?.[0] })]), h('button', { onClick: create }, '创建并上传'),
      ]),
      tab.value === 'paper' ? h('table', { style: 'width:100%' }, [h('tbody', papers.value.map(paper => h('tr', { key: paper.id }, [h('td', `${paper.id} ${paper.month} 第${paper.issueNumber}期 ${paper.title}`), h('td', `备份：${paper.backupState ?? 'disabled'}`), h('td', [h('button', { onClick: () => inspectPaper(paper) }, '关联详情'), h('button', { onClick: () => associateExisting(paper) }, '关联现有 Work'), h('button', { onClick: () => createAssociatedWork(paper) }, '新建并关联 Work'), h('button', { onClick: () => paperAttachment(paper, false) }, '预览'), h('button', { onClick: () => paperAttachment(paper, true) }, '下载'), h('button', { onClick: () => editPaper(paper) }, '编辑'), h('button', { onClick: () => removeRecord(paper, 'paper') }, '移除'), h('label', ['替换 PDF', h('input', { type: 'file', accept: '.pdf', style: 'display:none', onChange: (event: Event) => upload('paper', paper.id, (event.target as HTMLInputElement).files?.[0]) })])])])))] )
        : h('table', { style: 'width:100%' }, [h('tbody', works.value.map(work => h('tr', { key: work.id }, [h('td', `${work.id} ${work.author} - ${work.title}`), h('td', `备份：${work.backupState ?? 'disabled'}`), h('td', [h('button', { onClick: () => inspectWork(work) }, '文件树'), h('button', { onClick: () => downloadWork(work) }, '下载 ZIP'), h('button', { onClick: () => editWork(work) }, '编辑'), h('button', { onClick: () => removeRecord(work, 'work') }, '移除'), h('label', ['替换 ZIP', h('input', { type: 'file', accept: '.zip', style: 'display:none', onChange: (event: Event) => upload('work', work.id, (event.target as HTMLInputElement).files?.[0]) })])])])))]),
      paperPreview.value && h('iframe', { src: paperPreview.value, title: 'Paper PDF 预览', style: 'width:100%;height:70vh;border:1px solid #ddd' }),
      selectedPaper.value && h('section', [h('h2', `${selectedPaper.value.paper.id} 收录作品`), h('ul', selectedPaper.value.works.map(item => h('li', { key: item.work.id }, [`${item.work.id} ${item.work.author} - ${item.work.title}${item.page ? ` · 第${item.page}页` : ''}${item.section ? ` · ${item.section}` : ''} `, h('button', { onClick: () => removeAppearance(selectedPaper.value!.paper, item.work.id) }, '移除关联')])))]),
      selectedWork.value && h('section', [h('h2', `${selectedWork.value.id} 文件树`), workPapers.value.length > 0 && h('p', `刊载于：${workPapers.value.map(item => `${item.paper.id} ${item.paper.title}${item.page ? `（第${item.page}页）` : ''}${item.section ? `（${item.section}）` : ''}`).join('；')}`), h('ul', tree.value.map(entry => h('li', { key: entry.path }, [h('button', { disabled: !entry.previewable, onClick: () => previewFile(entry) }, entry.path), ` (${entry.kind}, ${entry.size} bytes) `, h('button', { onClick: () => downloadTreeFile(entry) }, '下载')]))), previewNode()]),
    ])
  },
})

export default (ctx: Context) => ctx.page({ id: 'memebot-archive', path: '/memebot/archive', name: 'Archive 归档', icon: 'activity:database', component: ArchivePage })

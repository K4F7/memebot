import { Context, send } from '@koishijs/client'
import { defineComponent, h, onMounted, ref } from 'vue'

interface Paper { id: string; title: string; issueNumber: string; month: string; description?: string; sourceLink?: string; backupState?: string }
interface Work { id: string; title: string; author: string; description?: string; backupState?: string }
interface TreeEntry { path: string; size: number; previewable: boolean; kind: string }
interface Health { state: 'ready' | 'degraded' | 'unavailable'; lastCheck: string; stores: { local: { ok: boolean; error?: string }; r2: { enabled: boolean; ok?: boolean; error?: string } }; queue: { pending: number; failed: number; complete: number } }

const ArchivePage = defineComponent({
  name: 'MemebotArchive',
  setup() {
    const tab = ref<'paper' | 'work'>('paper')
    const health = ref<Health>()
    const papers = ref<Paper[]>([]); const works = ref<Work[]>([]); const query = ref('')
    const title = ref(''); const issueNumber = ref(''); const month = ref(''); const author = ref(''); const description = ref(''); const sourceLink = ref('')
    const file = ref<File>(); const paperPreview = ref(''); const tree = ref<TreeEntry[]>([]); const selectedWork = ref<Work>(); const workPreview = ref<any>(); const error = ref('')

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
    const upload = async (kind: 'paper' | 'work', id: string, next?: File) => {
      if (!next) return
      try { await send(`memebot/archive/${kind}/upload`, id, { filename: next.name, contentType: next.type || (kind === 'paper' ? 'application/pdf' : 'application/zip'), data: await asDataUrl(next) }); await load(); await loadStatus() } catch (cause) { error.value = String(cause) }
    }
    const inspectWork = async (work: Work) => { try { selectedWork.value = work; tree.value = await send('memebot/archive/work/tree', work.id) as TreeEntry[]; workPreview.value = undefined } catch (cause) { error.value = String(cause) } }
    const previewFile = async (entry: TreeEntry) => { if (!selectedWork.value) return; try { workPreview.value = { entry, result: await send('memebot/archive/work/preview', selectedWork.value.id, entry.path) } } catch (cause) { error.value = String(cause) } }
    const downloadWork = async (work: Work) => { try { downloadData(await send('memebot/archive/work/download', work.id) as any) } catch (cause) { error.value = String(cause) } }
    const downloadTreeFile = async (entry: TreeEntry) => { if (!selectedWork.value) return; try { downloadData({ ...(await send('memebot/archive/work/file', selectedWork.value.id, entry.path) as any), contentType: 'application/octet-stream' }) } catch (cause) { error.value = String(cause) } }
    const recheck = async () => { try { await send('memebot/archive/recheck'); await loadStatus() } catch (cause) { error.value = String(cause) } }
    const retry = async () => { try { await send('memebot/archive/backup/retry'); await loadStatus(); await load() } catch (cause) { error.value = String(cause) } }

    onMounted(async () => { await Promise.all([load(), loadStatus()]) })
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
    return () => h('main', { style: 'padding:24px;display:grid;gap:20px' }, [
      h('h1', 'Archive 归档'), status(), error.value && h('p', { style: 'color:#c33' }, error.value),
      h('nav', { style: 'display:flex;gap:8px' }, [h('button', { disabled: tab.value === 'paper', onClick: async () => { tab.value = 'paper'; query.value = ''; await load() } }, 'Paper'), h('button', { disabled: tab.value === 'work', onClick: async () => { tab.value = 'work'; query.value = ''; await load() } }, 'Work')]),
      h('section', { style: 'display:flex;gap:8px' }, [h('input', { placeholder: tab.value === 'paper' ? '月份、期号、标题或描述' : '标题、作者或描述', value: query.value, onInput: (event: Event) => query.value = (event.target as HTMLInputElement).value }), h('button', { onClick: load }, '搜索')]),
      h('section', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px' }, [
        input('标题', title), ...(tab.value === 'paper' ? [input('期号', issueNumber), input('月份（YYYY-MM）', month), input('来源链接', sourceLink, 'url')] : [input('作者', author)]), input('描述', description),
        h('label', { style: 'display:grid;gap:4px' }, [tab.value === 'paper' ? 'PDF' : 'ZIP Work Package', h('input', { type: 'file', accept: tab.value === 'paper' ? 'application/pdf,.pdf' : 'application/zip,.zip', onChange: (event: Event) => file.value = (event.target as HTMLInputElement).files?.[0] })]), h('button', { onClick: create }, '创建并上传'),
      ]),
      tab.value === 'paper' ? h('table', { style: 'width:100%' }, [h('tbody', papers.value.map(paper => h('tr', { key: paper.id }, [h('td', `${paper.id} ${paper.month} 第${paper.issueNumber}期 ${paper.title}`), h('td', `备份：${paper.backupState ?? 'disabled'}`), h('td', [h('button', { onClick: () => paperAttachment(paper, false) }, '预览'), h('button', { onClick: () => paperAttachment(paper, true) }, '下载'), h('button', { onClick: () => editPaper(paper) }, '编辑'), h('label', ['替换 PDF', h('input', { type: 'file', accept: '.pdf', style: 'display:none', onChange: (event: Event) => upload('paper', paper.id, (event.target as HTMLInputElement).files?.[0]) })])])])))] )
        : h('table', { style: 'width:100%' }, [h('tbody', works.value.map(work => h('tr', { key: work.id }, [h('td', `${work.id} ${work.author} - ${work.title}`), h('td', `备份：${work.backupState ?? 'disabled'}`), h('td', [h('button', { onClick: () => inspectWork(work) }, '文件树'), h('button', { onClick: () => downloadWork(work) }, '下载 ZIP'), h('button', { onClick: () => editWork(work) }, '编辑'), h('label', ['替换 ZIP', h('input', { type: 'file', accept: '.zip', style: 'display:none', onChange: (event: Event) => upload('work', work.id, (event.target as HTMLInputElement).files?.[0]) })])])])))]),
      paperPreview.value && h('iframe', { src: paperPreview.value, title: 'Paper PDF 预览', style: 'width:100%;height:70vh;border:1px solid #ddd' }),
      selectedWork.value && h('section', [h('h2', `${selectedWork.value.id} 文件树`), h('ul', tree.value.map(entry => h('li', { key: entry.path }, [h('button', { disabled: !entry.previewable, onClick: () => previewFile(entry) }, entry.path), ` (${entry.kind}, ${entry.size} bytes) `, h('button', { onClick: () => downloadTreeFile(entry) }, '下载')]))), previewNode()]),
    ])
  },
})

export default (ctx: Context) => ctx.page({ id: 'memebot-archive', path: '/memebot/archive', name: 'Archive 归档', icon: 'activity:database', component: ArchivePage })

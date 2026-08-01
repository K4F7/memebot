import { Context, send } from '@koishijs/client'
import { defineComponent, h, onMounted, ref } from 'vue'

interface Paper {
  id: string
  title: string
  issueNumber: string
  month: string
  description?: string
  sourceLink?: string
}

const ArchivePage = defineComponent({
  name: 'MemebotArchive',
  setup() {
    const papers = ref<Paper[]>([])
    const query = ref('')
    const title = ref('')
    const issueNumber = ref('')
    const month = ref('')
    const description = ref('')
    const sourceLink = ref('')
    const file = ref<File>()
    const preview = ref('')
    const error = ref('')

    const load = async () => {
      try { papers.value = await send('memebot/archive/papers', query.value) as Paper[]; error.value = '' }
      catch (cause) { error.value = String(cause) }
    }
    const asDataUrl = (value: File) => new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(value)
    })
    const create = async () => {
      if (!file.value) { error.value = '请选择一个 PDF。'; return }
      try {
        await send('memebot/archive/paper/create', {
          title: title.value, issueNumber: issueNumber.value, month: month.value,
          description: description.value, sourceLink: sourceLink.value,
          attachment: { filename: file.value.name, contentType: file.value.type || 'application/pdf', data: await asDataUrl(file.value) },
        })
        title.value = issueNumber.value = month.value = description.value = sourceLink.value = ''
        file.value = undefined
        await load()
      } catch (cause) { error.value = String(cause) }
    }
    const attachment = async (paper: Paper, download: boolean) => {
      try {
        const result = await send(download ? 'memebot/archive/paper/download' : 'memebot/archive/paper/preview', paper.id) as { filename: string; contentType: string; data: string }
        const url = `data:${result.contentType};base64,${result.data}`
        if (!download) { preview.value = url; return }
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = result.filename; anchor.click()
      } catch (cause) { error.value = String(cause) }
    }
    const edit = async (paper: Paper) => {
      const nextTitle = window.prompt('Paper 标题', paper.title)
      if (nextTitle == null) return
      const nextIssueNumber = window.prompt('期号', paper.issueNumber)
      if (nextIssueNumber == null) return
      const nextMonth = window.prompt('月份（YYYY-MM）', paper.month)
      if (nextMonth == null) return
      const nextDescription = window.prompt('描述', paper.description ?? '')
      if (nextDescription == null) return
      const nextSourceLink = window.prompt('来源链接', paper.sourceLink ?? '')
      if (nextSourceLink == null) return
      try { await send('memebot/archive/paper/edit', paper.id, { title: nextTitle, issueNumber: nextIssueNumber, month: nextMonth, description: nextDescription, sourceLink: nextSourceLink }); await load() }
      catch (cause) { error.value = String(cause) }
    }
    const upload = async (paper: Paper, next: File | undefined) => {
      if (!next) return
      try {
        await send('memebot/archive/paper/upload', paper.id, { filename: next.name, contentType: next.type || 'application/pdf', data: await asDataUrl(next) })
        await load()
      } catch (cause) { error.value = String(cause) }
    }

    onMounted(load)
    const input = (label: string, value: typeof title, type = 'text') => h('label', { style: 'display:grid;gap:4px' }, [label, h('input', { type, value: value.value, onInput: (event: Event) => value.value = (event.target as HTMLInputElement).value })])
    return () => h('main', { style: 'padding:24px;display:grid;gap:24px' }, [
      h('h1', 'Paper 归档'),
      error.value && h('p', { style: 'color:#c33' }, error.value),
      h('section', { style: 'display:flex;gap:8px' }, [h('input', { placeholder: '月份、期号、标题或描述', value: query.value, onInput: (event: Event) => query.value = (event.target as HTMLInputElement).value }), h('button', { onClick: load }, '搜索')]),
      h('section', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px' }, [
        input('标题', title), input('期号', issueNumber), input('月份（YYYY-MM）', month), input('描述', description), input('来源链接', sourceLink, 'url'),
        h('label', { style: 'display:grid;gap:4px' }, ['PDF', h('input', { type: 'file', accept: 'application/pdf,.pdf', onChange: (event: Event) => file.value = (event.target as HTMLInputElement).files?.[0] })]),
        h('button', { onClick: create }, '创建并上传'),
      ]),
      h('table', { style: 'width:100%;border-collapse:collapse' }, [
        h('thead', [h('tr', ['编号', '月份', '期号', '标题', '操作'].map(cell => h('th', { style: 'text-align:left;padding:8px' }, cell)))]),
        h('tbody', papers.value.map(paper => h('tr', { key: paper.id }, [
          h('td', { style: 'padding:8px' }, paper.id), h('td', { style: 'padding:8px' }, paper.month), h('td', { style: 'padding:8px' }, paper.issueNumber), h('td', { style: 'padding:8px' }, paper.title),
          h('td', { style: 'padding:8px;display:flex;gap:6px;flex-wrap:wrap' }, [
            h('button', { onClick: () => attachment(paper, false) }, '预览'), h('button', { onClick: () => attachment(paper, true) }, '下载'), h('button', { onClick: () => edit(paper) }, '编辑'),
            h('label', [h('span', { style: 'cursor:pointer;text-decoration:underline' }, '替换 PDF'), h('input', { type: 'file', accept: 'application/pdf,.pdf', style: 'display:none', onChange: (event: Event) => upload(paper, (event.target as HTMLInputElement).files?.[0]) })]),
          ]),
        ]))),
      ]),
      preview.value && h('iframe', { src: preview.value, title: 'Paper PDF 预览', style: 'width:100%;height:70vh;border:1px solid #ddd' }),
    ])
  },
})

export default (ctx: Context) => ctx.page({ id: 'memebot-archive', path: '/memebot/archive', name: 'Paper 归档', icon: 'activity:database', component: ArchivePage })

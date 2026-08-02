import { Context, send } from '@koishijs/client'
import { defineComponent, h, onMounted, ref } from 'vue'

interface AccessSnapshot {
  administrators: string[]
  managementGroups: string[]
}

const AccessPage = defineComponent({
  name: 'MemebotAccessPage',
  setup() {
    const snapshot = ref<AccessSnapshot>({ administrators: [], managementGroups: [] })
    const administrator = ref('')
    const managementGroup = ref('')
    const loading = ref(false)
    const error = ref('')

    const request = async (type: string, qq?: string) => {
      loading.value = true
      error.value = ''
      try {
        snapshot.value = await send(type, ...(qq === undefined ? [] : [qq])) as AccessSnapshot
      } catch (cause) {
        error.value = cause instanceof Error ? cause.message : String(cause)
      } finally {
        loading.value = false
      }
    }
    const add = async (kind: 'admin' | 'group') => {
      const input = kind === 'admin' ? administrator : managementGroup
      await request(`memebot/access/${kind}/add`, input.value)
      if (!error.value) input.value = ''
    }
    const remove = (kind: 'admin' | 'group', qq: string) => request(`memebot/access/${kind}/remove`, qq)

    onMounted(() => request('memebot/access/list'))

    const collection = (options: {
      title: string
      description: string
      kind: 'admin' | 'group'
      values: string[]
      input: typeof administrator
      label: string
    }) => h('section', { style: 'padding:20px;border:1px solid var(--k-color-divider);border-radius:10px' }, [
      h('h2', options.title),
      h('p', options.description),
      h('form', {
        style: 'display:flex;gap:8px;flex-wrap:wrap;margin:16px 0',
        onSubmit: (event: Event) => { event.preventDefault(); void add(options.kind) },
      }, [
        h('label', { style: 'display:grid;gap:4px;flex:1;min-width:220px' }, [
          h('span', options.label),
          h('input', {
            value: options.input.value,
            inputmode: 'numeric',
            pattern: '[0-9]+',
            required: true,
            disabled: loading.value,
            onInput: (event: Event) => { options.input.value = (event.target as HTMLInputElement).value },
          }),
        ]),
        h('button', { type: 'submit', disabled: loading.value, style: 'align-self:end' }, '添加'),
      ]),
      options.values.length
        ? h('ul', options.values.map(qq => h('li', { key: qq, style: 'display:flex;gap:12px;align-items:center;margin:8px 0' }, [
          h('code', { style: 'flex:1' }, qq),
          h('button', { type: 'button', disabled: loading.value, onClick: () => void remove(options.kind, qq) }, '移除'),
        ])))
        : h('p', '当前为空。'),
    ])

    return () => h('main', { style: 'padding:24px;max-width:960px;margin:auto' }, [
      h('h1', 'Access 授权'),
      h('p', '管理持久化的显式管理员 QQ 与管理群。Koishi authority 4 用户不会显示在此列表中。'),
      error.value && h('p', { role: 'alert', style: 'color:var(--k-color-danger)' }, error.value),
      h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px' }, [
        collection({ title: '显式管理员', description: '可在任意聊天读取管理数据，并按位置规则执行变更。', kind: 'admin', values: snapshot.value.administrators, input: administrator, label: '管理员 QQ' }),
        collection({ title: '管理群', description: '只有列出的群可执行聊天侧状态变更。', kind: 'group', values: snapshot.value.managementGroups, input: managementGroup, label: 'QQ群号' }),
      ]),
    ])
  },
})

export default (ctx: Context) => ctx.page({
  id: 'memebot-access',
  path: '/memebot/access',
  name: 'Access 授权',
  authority: 1,
  component: AccessPage,
})

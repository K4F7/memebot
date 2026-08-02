import { Context, icons } from '@koishijs/client'

import ArchiveIcon from './icons/ArchiveIcon.vue'
import ArchivePage from './pages/ArchivePage.vue'

export default (ctx: Context) => {
  icons.register('activity:archive', ArchiveIcon)
  ctx.page({
    id: 'memebot-archive',
    path: '/memebot/archive',
    name: '迷因档案',
    icon: 'activity:archive',
    authority: 1,
    component: ArchivePage,
  })
}

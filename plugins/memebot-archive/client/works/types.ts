export interface WorkAttachment {
  relativePath: string
  contentType: string
  size: number
  checksum: string
}

export interface Work {
  id: string
  title: string
  author: string
  description?: string
  attachment?: WorkAttachment
  publishedAt: string
  updatedAt?: string
  backupState?: 'disabled' | 'pending' | 'failed' | 'complete'
  backupError?: string
}

export interface WorkPaper {
  paper: {
    id: string
    month: string
    issueNumber: string
    title: string
  }
  page?: string
  section?: string
  displayOrder: number
}

export interface WorkDetails {
  work: Work
  papers: WorkPaper[]
}

export interface AppearanceFormValue {
  paperId: string
  page: string
  section: string
  displayOrder: number
}

export interface WorkFormValue {
  title: string
  author: string
  description: string
  file?: File
}

export interface ConsoleAttachment {
  filename: string
  contentType: string
  data: string
}

export interface WorkPreviewEntry {
  path: string
  size: number
  previewable: boolean
  kind: string
}

export interface WorkPreviewResult {
  previewable: boolean
  kind: string
  contentType?: string
  text?: string
  data?: string
  sandbox?: string
}

export interface DownloadResult {
  filename: string
  contentType?: string
  data: string
}

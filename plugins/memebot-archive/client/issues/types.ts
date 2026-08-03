export interface IssueAttachment {
  relativePath: string
  contentType: string
  size: number
  checksum: string
}

export interface NewspaperIssue {
  id: string
  issueNumber: string
  month: string
  title: string
  description?: string
  sourceLink?: string
  attachment?: IssueAttachment
  publishedAt: string
  updatedAt?: string
  backupState?: 'disabled' | 'pending' | 'failed' | 'complete'
  backupError?: string
}

export interface IssueWorkAppearance {
  work: {
    id: string
    title: string
    author: string
    lifecycle?: 'active' | 'removed' | 'purged'
  }
  page?: string
  section?: string
  displayOrder: number
  unavailable?: boolean
}

export interface IssueDetails {
  paper: NewspaperIssue
  works: IssueWorkAppearance[]
}

export interface IssueFormValue {
  month: string
  issueNumber: string
  title: string
  description: string
  sourceLink: string
  file?: File
}

export interface ConsoleAttachment {
  filename: string
  contentType: string
  data: string
}

export interface PdfResult {
  filename: string
  contentType?: string
  data: string
}

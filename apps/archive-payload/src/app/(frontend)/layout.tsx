import React from 'react'
import './styles.css'

export const metadata = {
  title: 'MemeBot Archive',
  description: 'Payload-powered Archive administration',
}

export default function FrontendLayout({ children }: { children: React.ReactNode }) {
  return <html lang="zh-CN"><body><main>{children}</main></body></html>
}

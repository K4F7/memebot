import React from 'react'

type StatCardProps = {
  label: string
  value: number | string
  hint?: string
  href?: string
  tone?: 'default' | 'warning' | 'muted'
}

export function StatCard({ label, value, hint, href, tone = 'default' }: StatCardProps) {
  const className = [
    'mb-archive-stat',
    `mb-archive-stat--${tone}`,
    href ? 'mb-archive-stat--link' : '',
  ].filter(Boolean).join(' ')

  const body = (
    <>
      <div className="mb-archive-stat__label">{label}</div>
      <div className="mb-archive-stat__value">{value}</div>
      {hint ? <div className="mb-archive-stat__hint">{hint}</div> : null}
    </>
  )

  if (href) {
    return (
      <a className={className} href={href}>
        {body}
      </a>
    )
  }

  return <div className={className}>{body}</div>
}

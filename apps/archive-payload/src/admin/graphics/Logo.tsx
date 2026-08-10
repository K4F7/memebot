import React from 'react'

export default function Logo() {
  return (
    <div className="mb-archive-logo" aria-label="MemeBot 档案管理">
      <svg
        className="mb-archive-logo__mark"
        viewBox="0 0 64 64"
        width="48"
        height="48"
        role="img"
        aria-hidden="true"
      >
        <rect x="4" y="8" width="56" height="48" rx="10" fill="currentColor" opacity="0.12" />
        <path
          d="M16 44V20h8.4l7.6 14.8L39.6 20H48v24h-7.2V31.6L33.2 44h-2.4L23.2 31.6V44H16z"
          fill="currentColor"
        />
        <circle cx="50" cy="16" r="5" fill="currentColor" opacity="0.85" />
      </svg>
      <div className="mb-archive-logo__text">
        <strong>MemeBot 档案管理</strong>
        <span>Archive Admin</span>
      </div>
    </div>
  )
}

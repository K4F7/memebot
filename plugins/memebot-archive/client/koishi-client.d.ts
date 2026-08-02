declare module '@koishijs/client' {
  import type { Component } from 'vue'

  export class Context {
    page(options: Record<string, unknown>): unknown
  }

  export const icons: {
    register(name: string, component: Component): void
  }

  export const router: {
    currentRoute: {
      value: {
        path: string
        query: Record<string, unknown>
      }
    }
    replace(location: { path: string; query: Record<string, string> }): Promise<unknown>
  }

  export const message: {
    success(content: string): void
    error(content: string): void
  }

  export const messageBox: {
    confirm(message: string, title: string, options?: Record<string, unknown>): Promise<unknown>
  }

  export function send(type: string, ...args: unknown[]): Promise<unknown>
}

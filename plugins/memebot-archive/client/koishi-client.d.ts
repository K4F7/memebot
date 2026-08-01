declare module '@koishijs/client' {
  export class Context {
    page(options: Record<string, unknown>): unknown
  }

  export function send(type: string, ...args: unknown[]): Promise<unknown>
}

declare global {
  interface Window {
    agent: Readonly<Record<string, never>>
  }
}

export {}

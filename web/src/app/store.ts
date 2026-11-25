import { useEffect, useState } from 'preact/hooks'

/** A value the interface can watch. */
export class Store<T> {
  private readonly listeners = new Set<(value: T) => void>()

  constructor(private current: T) {}

  get value(): T {
    return this.current
  }

  set(next: T): void {
    if (Object.is(next, this.current)) return
    this.current = next
    for (const listener of [...this.listeners]) listener(next)
  }

  update(change: (value: T) => T): void {
    this.set(change(this.current))
  }

  subscribe(listener: (value: T) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export function useStore<T>(store: Store<T>): T {
  const [value, setValue] = useState(store.value)
  useEffect(() => {
    setValue(store.value)
    return store.subscribe(setValue)
  }, [store])
  return value
}

import { createContext, type ReactNode, useContext, useState } from "react";

interface ShellMemory {
  pages: Map<string, { scrollTop: number; focusHref?: string }>;
  values: Map<string, unknown>;
}

const MemoryContext = createContext<ShellMemory | undefined>(undefined);

/** Session-local state disappears with the authenticated shell, including on sign-out. */
export function ShellMemoryProvider({ children }: { children: ReactNode }) {
  const [memory] = useState<ShellMemory>(() => ({ pages: new Map(), values: new Map() }));
  return <MemoryContext value={memory}>{children}</MemoryContext>;
}

export function useShellMemory() {
  return useContext(MemoryContext);
}

/** Pages provide their own identity, so this hook does not couple them to the router. */
export function useRememberedState<T>(key: string, initial: T): [T, (value: T) => void] {
  const memory = useShellMemory();
  const read = () => (memory?.values.has(key) ? (memory.values.get(key) as T) : initial);
  const [state, setState] = useState(() => ({ key, value: read() }));
  let value = state.value;
  if (state.key !== key) {
    value = read();
    setState({ key, value });
  }
  return [
    value,
    (next) => {
      memory?.values.set(key, next);
      setState({ key, value: next });
    },
  ];
}

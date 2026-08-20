import { useEffect, useRef, useState } from "react";

export type LoadState<T> = { kind: "loading" } | { kind: "error"; error: Error } | { kind: "ready"; value: T };

export function useResource<T>(loader: () => Promise<T>, key: string): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>({ kind: "loading" });
  const loaderRef = useRef(loader);
  const keyRef = useRef(key);
  loaderRef.current = loader;
  keyRef.current = key;
  useEffect(() => {
    let active = true;
    const activeKey = key;
    setState({ kind: "loading" });
    void loaderRef.current().then(
      (value) => active && keyRef.current === activeKey && setState({ kind: "ready", value }),
      (error: unknown) =>
        active &&
        keyRef.current === activeKey &&
        setState({ kind: "error", error: error instanceof Error ? error : new Error(String(error)) }),
    );
    return () => {
      active = false;
    };
  }, [key]);
  return state;
}

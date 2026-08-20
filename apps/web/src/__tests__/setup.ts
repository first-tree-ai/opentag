import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

vi.stubGlobal("fetch", vi.fn());

afterEach(() => {
  cleanup();
  vi.mocked(fetch).mockReset();
  window.history.replaceState({}, "", "/");
});

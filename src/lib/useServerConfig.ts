import { useEffect, useState } from "react";
import { DEFAULT_LIMITS } from "../../shared/config";
import type { ConfigResponse } from "../../shared/contracts";

export type ServerConfigState = { status: "loading" } | { status: "ready"; config: ConfigResponse } | { status: "offline" };

export function useServerConfig(): ServerConfigState {
  const [state, setState] = useState<ServerConfigState>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/config", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        setState({ status: "ready", config: (await response.json()) as ConfigResponse });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: "offline" });
      });
    return () => controller.abort();
  }, []);
  return state;
}

export function limitsFrom(state: ServerConfigState) {
  return state.status === "ready" ? state.config.limits : DEFAULT_LIMITS;
}

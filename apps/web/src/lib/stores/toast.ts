import { writable } from "svelte/store";

export interface Toast {
  id: string;
  type: "success" | "error" | "info" | "warning";
  message: string;
  duration?: number;
}

function createToastStore() {
  const { subscribe, update } = writable<Toast[]>([]);

  function add(type: Toast["type"], message: string, duration = 4000) {
    const id = crypto.randomUUID();
    update((toasts) => [...toasts, { id, type, message, duration }]);
    if (duration > 0) {
      setTimeout(() => remove(id), duration);
    }
    return id;
  }

  function remove(id: string) {
    update((toasts) => toasts.filter((t) => t.id !== id));
  }

  return {
    subscribe,
    // #843 (D-843-01 block 9): a success is an acknowledgement, 2.6 s is enough to read it.
    success: (msg: string, duration?: number) => add("success", msg, duration ?? 2600),
    error: (msg: string, duration?: number) => add("error", msg, duration ?? 6000),
    info: (msg: string, duration?: number) => add("info", msg, duration),
    warning: (msg: string, duration?: number) => add("warning", msg, duration ?? 5000),
    remove,
  };
}

export const toasts = createToastStore();

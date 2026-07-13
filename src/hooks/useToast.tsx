import { createContext, useCallback, useContext, useRef, useState } from "react";

type ToastKind = "info" | "success" | "warning" | "error";

type ToastItem = {
  id: number;
  text: string;
  kind: ToastKind;
};

type ToastContextValue = {
  toast: (text: string, kind?: ToastKind) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_DURATION_MS = 3000;
const TOAST_FADE_MS = 300;

let nextId = 1;

/**
 * Toast 消息提供者
 *
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const toast = useCallback((text: string, kind: ToastKind = "info") => {
    const id = nextId++;
    setToasts((prev) => [...prev, { id, text, kind }]);

    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      timersRef.current.delete(id);
    }, TOAST_DURATION_MS + TOAST_FADE_MS);

    timersRef.current.set(id, timer);
  }, []);

  const dismiss = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {toasts.length > 0 ? (
        <div className="toast-container" aria-live="polite">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`toast-item toast-${t.kind}`}
              onClick={() => dismiss(t.id)}
              role="status"
            >
              <span className="toast-icon">
                {t.kind === "success" ? "✓" : t.kind === "error" ? "✕" : t.kind === "warning" ? "!" : "i"}
              </span>
              <span className="toast-text">{t.text}</span>
            </div>
          ))}
        </div>
      ) : null}
    </ToastContext.Provider>
  );
}

/**
 * 使用 Toast 消息
 *
 */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

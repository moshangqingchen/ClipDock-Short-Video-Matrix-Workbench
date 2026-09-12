import { useEffect, useState } from "react";

export function usePlatformCollapse(scope: string) {
  const key = `clipdock.sidebar.collapsed.${scope}`;
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
      return value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === "boolean"))
        : {};
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(collapsed));
    } catch {
      /* Optional preference. */
    }
  }, [collapsed, key]);
  return [collapsed, setCollapsed] as const;
}

import { useEffect, useRef, useState } from "react";
import { MoreHorizontal, type LucideIcon } from "lucide-react";
import { Button, Menu, MenuItem } from "./index";
export interface WorkspaceAction {
  label: string;
  icon: LucideIcon;
  onClick(): void;
  disabled?: boolean;
  active?: boolean;
}
/** Reserve real button widths; the overflow list remains keyboard accessible. */
export function WorkspaceActions({ items }: { items: WorkspaceAction[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0),
    [anchor, setAnchor] = useState<DOMRect | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);
  const count = Math.max(0, Math.min(items.length, Math.floor((width - 88) / 100)));
  return (
    <div
      ref={ref}
      style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0, flex: 1, overflow: "hidden" }}
    >
      {items.slice(0, count).map((item) => (
        <Button
          key={item.label}
          variant={item.active ? "soft" : "ghost"}
          size="sm"
          icon={item.icon}
          disabled={item.disabled}
          onClick={item.onClick}
          style={{ flexShrink: 0 }}
        >
          {item.label}
        </Button>
      ))}
      {count < items.length ? (
        <Button
          size="sm"
          variant="ghost"
          icon={MoreHorizontal}
          onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
        >
          更多
        </Button>
      ) : null}
      <Menu anchor={anchor} onClose={() => setAnchor(null)}>
        {items.slice(count).map((item) => (
          <MenuItem
            key={item.label}
            icon={item.icon}
            disabled={item.disabled}
            onClick={() => {
              setAnchor(null);
              item.onClick();
            }}
          >
            {item.label}
          </MenuItem>
        ))}
      </Menu>
    </div>
  );
}

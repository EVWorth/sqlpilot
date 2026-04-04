import { Plus, X } from "lucide-react";
import { useEditorStore } from "../../stores/editorStore";
import { cn } from "../../lib/utils";

export function EditorTabs() {
  const tabs = useEditorStore((s) => s.tabs);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const setActiveTab = useEditorStore((s) => s.setActiveTab);
  const closeTab = useEditorStore((s) => s.closeTab);
  const addTab = useEditorStore((s) => s.addTab);

  return (
    <div className="flex h-9 items-center border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
      <div className="flex flex-1 items-center overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "group flex h-9 items-center gap-1.5 border-r border-[var(--color-border)] px-3 text-xs transition-colors",
              activeTabId === tab.id
                ? "bg-[var(--color-bg-primary)] text-[var(--color-text-primary)]"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]",
            )}
          >
            <span>{tab.title}</span>
            {tab.isDirty && (
              <span className="h-1.5 w-1.5 rounded-full bg-brand-400" />
            )}
            <span
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
              className="ml-1 rounded p-0.5 opacity-0 hover:bg-[var(--color-bg-tertiary)] group-hover:opacity-100"
            >
              <X className="h-3 w-3" />
            </span>
          </button>
        ))}
      </div>
      <button
        onClick={() => addTab()}
        className="flex h-9 w-9 items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
      >
        <Plus className="h-4 w-4" />
      </button>
    </div>
  );
}

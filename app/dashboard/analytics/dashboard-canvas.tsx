"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import type { ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus, Search, X } from "lucide-react";
import {
  resetAnalyticsDashboardLayout,
  saveAnalyticsDashboardLayout,
} from "@/app/actions/analytics-layout";
import type { AnalyticsLayoutView } from "@/lib/analytics/layout";

import {
  WIDGETS,
  WIDGET_GROUPS,
  defaultLayoutFor,
  layoutStorageKey,
  normalizeLayout,
  type WidgetId,
} from "./widgets";

// The Analytics canvas: renders the merchant's chosen widgets in their chosen
// order, and hosts "Edit dashboard" (drag to reorder, X to remove, Add section
// to bring one back, Reset to default).
//
// Widget CONTENT is server-rendered — the page passes each card in as a
// ReactNode `slot`, so this client component never re-fetches or re-renders the
// data, it only decides WHICH nodes appear and WHERE. Cards stay Server
// Components; only the chrome is client.
//
// Layout persistence is localStorage, per store. A dashboard arrangement is a
// personal display preference, not store data: it needs no migration, no round
// trip, and a lost layout costs nothing (it falls back to the default). If it
// ever needs to follow a user across devices, `readLayout`/`writeLayout` below
// are the two functions to swap for a server action.

interface DashboardCanvasProps {
  storeId: string;
  /** Server-rendered card for each widget the viewer is allowed to see. */
  slots: Partial<Record<WidgetId, ReactNode>>;
  headerExtras?: ReactNode;
  initialLayout: AnalyticsLayoutView;
}

function readLegacyLayout(
  storeId: string,
  allowed: WidgetId[],
): WidgetId[] | null {
  try {
    const raw = window.localStorage.getItem(layoutStorageKey(storeId));
    return normalizeLayout(raw ? JSON.parse(raw) : null, allowed);
  } catch {
    return null;
  }
}

function removeLegacyLayout(storeId: string) {
  try {
    window.localStorage.removeItem(layoutStorageKey(storeId));
  } catch {
    // Private mode / storage policy: server persistence is already authoritative.
  }
}

export function DashboardCanvas({
  storeId,
  slots,
  headerExtras,
  initialLayout,
}: DashboardCanvasProps) {
  const allowed = useMemo(
    () => Object.keys(slots).filter((id): id is WidgetId => id in WIDGETS),
    [slots],
  );

  // The server-selected layout is the first paint, so hydration and the saved
  // cross-device preference agree. localStorage is read once only as a legacy
  // migration input when no server row exists.
  const [layout, setLayout] = useState<WidgetId[]>(initialLayout.items);
  const [layoutConfigured, setLayoutConfigured] = useState(
    initialLayout.configured,
  );
  const [updatedAt, setUpdatedAt] = useState(initialLayout.updatedAt);
  const [draft, setDraft] = useState<WidgetId[] | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [resetRequested, setResetRequested] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const legacyAttempted = useRef(false);

  useEffect(() => {
    if (legacyAttempted.current) return;
    legacyAttempted.current = true;
    if (layoutConfigured) {
      removeLegacyLayout(storeId);
      return;
    }
    const legacy = readLegacyLayout(storeId, allowed);
    if (legacy === null) return;
    startTransition(async () => {
      const result = await saveAnalyticsDashboardLayout(legacy, null);
      if (result.success) {
        setLayout(legacy);
        setLayoutConfigured(true);
        setUpdatedAt(result.updatedAt ?? null);
        removeLegacyLayout(storeId);
      } else {
        setSaveError(
          result.error ?? "Couldn't import the saved browser layout.",
        );
      }
    });
  }, [allowed, layoutConfigured, storeId]);

  const editing = draft !== null;
  const visible = draft ?? layout;

  const startEditing = () => {
    setSaveError(null);
    setResetRequested(false);
    setDraft(layout);
  };
  const cancelEditing = () => {
    setDraft(null);
    setLibraryOpen(false);
    setResetRequested(false);
    setSaveError(null);
  };
  const save = () => {
    if (!draft || pending) return;
    const next = [...draft];
    setSaveError(null);
    startTransition(async () => {
      const result = resetRequested
        ? await resetAnalyticsDashboardLayout(updatedAt)
        : await saveAnalyticsDashboardLayout(next, updatedAt);
      if (!result.success) {
        setSaveError(result.error ?? "Couldn't save the dashboard.");
        return;
      }
      setLayout(resetRequested ? defaultLayoutFor(allowed) : next);
      setLayoutConfigured(!resetRequested);
      setUpdatedAt(result.updatedAt ?? null);
      setDraft(null);
      setLibraryOpen(false);
      setResetRequested(false);
      removeLegacyLayout(storeId);
    });
  };

  const remove = (id: WidgetId) => {
    setResetRequested(false);
    setDraft((d) => (d ? d.filter((w) => w !== id) : d));
  };
  const add = (id: WidgetId) => {
    setResetRequested(false);
    setDraft((d) => (d && !d.includes(id) ? [...d, id] : d));
  };
  const reset = () => {
    if (
      !window.confirm(
        "Reset this dashboard to StoreMink's current default layout?",
      )
    ) {
      return;
    }
    setDraft(defaultLayoutFor(allowed));
    setResetRequested(true);
    setSaveError(null);
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const onDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setResetRequested(false);
    setDraft((d) => {
      if (!d) return d;
      const from = d.indexOf(active.id as WidgetId);
      const to = d.indexOf(over.id as WidgetId);
      return from < 0 || to < 0 ? d : arrayMove(d, from, to);
    });
  }, []);

  const removed = allowed.filter((id) => !visible.includes(id));

  const grid = (
    <div className={`dash-canvas${editing ? " is-editing" : ""}`}>
      {visible.map((id) =>
        editing ? (
          <SortableWidget
            key={id}
            id={id}
            onRemove={() => remove(id)}
            node={slots[id]}
          />
        ) : (
          <Widget key={id} id={id} node={slots[id]} />
        ),
      )}
      {editing && (
        <EmptySlots
          count={removed.length > 0 ? Math.min(removed.length, 4) : 0}
          onClick={() => setLibraryOpen(true)}
        />
      )}
    </div>
  );

  return (
    <>
      {editing ? (
        <div className="dash-savebar">
          <div className="dash-savebar-msg">
            <span className="dash-savebar-dot" aria-hidden />
            <span>
              Editing dashboard — drag cards to reorder
              {saveError ? (
                <span className="dash-savebar-error" role="alert">
                  {saveError}
                </span>
              ) : null}
            </span>
          </div>
          <div className="dash-savebar-actions">
            <button type="button" className="dash-sb-btn" onClick={reset}>
              Reset to default
            </button>
            <button
              type="button"
              className="dash-sb-btn"
              onClick={cancelEditing}
            >
              Cancel
            </button>
            <button
              type="button"
              className="dash-sb-btn is-primary"
              onClick={save}
              disabled={pending}
            >
              {pending ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : null}

      <header className="dash-an-head">
        <h1>Analytics</h1>
        <div className="dash-an-actions">
          {!editing ? headerExtras : null}
          {editing ? (
            <div className="dash-lib-anchor">
              <button
                type="button"
                className="dash-an-btn"
                onClick={() => setLibraryOpen((o) => !o)}
                aria-expanded={libraryOpen}
              >
                <Plus className="h-[15px] w-[15px]" />
                Add section
              </button>
              {libraryOpen && (
                <SectionLibrary
                  removed={removed}
                  onAdd={(id) => add(id)}
                  onClose={() => setLibraryOpen(false)}
                />
              )}
            </div>
          ) : (
            <button
              type="button"
              className="dash-an-btn"
              onClick={startEditing}
            >
              Edit dashboard
            </button>
          )}
        </div>
      </header>

      {editing ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={visible} strategy={rectSortingStrategy}>
            {grid}
          </SortableContext>
        </DndContext>
      ) : (
        grid
      )}

      {visible.length === 0 && (
        <div className="dash-canvas-empty">
          <p>Your dashboard is empty.</p>
          <button
            type="button"
            className="dash-an-btn"
            onClick={() => {
              if (!editing) startEditing();
              setLibraryOpen(true);
            }}
          >
            <Plus className="h-[15px] w-[15px] " />
            Add a section
          </button>
        </div>
      )}
    </>
  );
}

/**
 * A placed widget. Two components rather than one conditional hook: useSortable
 * only works under a DndContext, and in the (overwhelmingly common) read-only
 * mode there is no DndContext to be under — so the static version doesn't call
 * dnd-kit at all.
 */
function Widget({ id, node }: { id: WidgetId; node: ReactNode }) {
  return (
    <div className={`dash-widget span-${WIDGETS[id].span}`}>
      <div className="dash-widget-body">{node}</div>
    </div>
  );
}

function SortableWidget({
  id,
  node,
  onRemove,
}: {
  id: WidgetId;
  node: ReactNode;
  onRemove: () => void;
}) {
  const meta = WIDGETS[id];
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  return (
    <div
      ref={setNodeRef}
      className={`dash-widget span-${meta.span}${isDragging ? " is-dragging" : ""}`}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
    >
      {/* The whole strip is the drag handle (a big, forgiving target); the
          card underneath already says what it is, so it carries no label. */}
      <div className="dash-widget-bar">
        <button
          type="button"
          className="dash-widget-grip"
          aria-label={`Move ${meta.title}`}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-[15px] w-[15px]" />
        </button>
        <button
          type="button"
          className="dash-widget-x"
          aria-label={`Remove ${meta.title}`}
          onClick={onRemove}
        >
          <X className="h-[14px] w-[14px]" />
        </button>
      </div>
      <div className="dash-widget-body">{node}</div>
    </div>
  );
}

/** Dashed drop targets shown while editing, mirroring Shopify's empty slots. */
function EmptySlots({
  count,
  onClick,
}: {
  count: number;
  onClick: () => void;
}) {
  if (count <= 0) return null;
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <button
          key={i}
          type="button"
          className="dash-slot span-1"
          onClick={onClick}
        >
          <Plus className="h-4 w-4" />
          Add section
        </button>
      ))}
    </>
  );
}

function SectionLibrary({
  removed,
  onAdd,
  onClose,
}: {
  removed: WidgetId[];
  onAdd: (id: WidgetId) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  // Click-away + Esc, so the panel behaves like the rest of the dashboard's
  // poppers.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const q = query.trim().toLowerCase();
  const matches = removed.filter((id) => {
    if (!q) return true;
    const meta = WIDGETS[id];
    return (
      meta.title.toLowerCase().includes(q) ||
      meta.description.toLowerCase().includes(q)
    );
  });

  return (
    <div className="dash-lib" ref={ref}>
      <div className="dash-lib-search">
        <Search className="h-[14px] w-[14px]" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search sections"
          aria-label="Search sections"
        />
      </div>
      <div className="dash-lib-list">
        {matches.length === 0 ? (
          <p className="dash-lib-empty">
            {removed.length === 0
              ? "Every section is already on your dashboard."
              : "No sections match that search."}
          </p>
        ) : (
          WIDGET_GROUPS.map((group) => {
            const items = matches.filter((id) => WIDGETS[id].group === group);
            if (items.length === 0) return null;
            return (
              <div key={group} className="dash-lib-group">
                <div className="dash-lib-group-label">{group}</div>
                {items.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className="dash-lib-item"
                    onClick={() => onAdd(id)}
                  >
                    <span className="dash-lib-item-title">
                      {WIDGETS[id].title}
                    </span>
                    <span className="dash-lib-item-desc">
                      {WIDGETS[id].description}
                    </span>
                  </button>
                ))}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  GripVertical,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import {
  resetAnalyticsDashboardLayout,
  saveAnalyticsDashboardLayout,
} from "@/app/actions/analytics-layout";
import {
  MAX_ANALYTICS_SECTIONS,
  availableWidgetSizes,
  defaultAnalyticsSections,
  legacyLayoutFromWidgetIds,
  storedAnalyticsLayout,
  type AnalyticsLayoutItem,
  type AnalyticsLayoutSection,
  type AnalyticsLayoutView,
  type AnalyticsWidgetSize,
} from "@/lib/analytics/layout";
import {
  WIDGETS,
  WIDGET_GROUPS,
  layoutStorageKey,
  normalizeLayout,
  type WidgetId,
} from "./widgets";

interface DashboardCanvasProps {
  storeId: string;
  slots: Partial<Record<WidgetId, ReactNode>>;
  headerExtras?: ReactNode;
  initialLayout: AnalyticsLayoutView;
}

function cloneSections(
  sections: readonly AnalyticsLayoutSection[],
): AnalyticsLayoutSection[] {
  return sections.map((section) => ({
    ...section,
    items: section.items.map((item) => ({ ...item })),
  }));
}

function readLegacyLayout(
  storeId: string,
  allowed: WidgetId[],
): AnalyticsLayoutSection[] | null {
  try {
    const raw = window.localStorage.getItem(layoutStorageKey(storeId));
    const widgetIds = normalizeLayout(raw ? JSON.parse(raw) : null, allowed);
    return widgetIds ? legacyLayoutFromWidgetIds(widgetIds).sections : null;
  } catch {
    return null;
  }
}

function removeLegacyLayout(storeId: string) {
  try {
    window.localStorage.removeItem(layoutStorageKey(storeId));
  } catch {
    // Server state is authoritative; a blocked localStorage cleanup is harmless.
  }
}

function itemLocation(sections: AnalyticsLayoutSection[], id: string) {
  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
    const itemIndex = sections[sectionIndex].items.findIndex(
      (item) => item.widgetId === id,
    );
    if (itemIndex >= 0) return { sectionIndex, itemIndex };
  }
  return null;
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
  const [layout, setLayout] = useState<AnalyticsLayoutSection[]>(() =>
    cloneSections(initialLayout.sections),
  );
  const [layoutConfigured, setLayoutConfigured] = useState(
    initialLayout.configured,
  );
  const [updatedAt, setUpdatedAt] = useState(initialLayout.updatedAt);
  const [draft, setDraft] = useState<AnalyticsLayoutSection[] | null>(null);
  const [librarySectionId, setLibrarySectionId] = useState<string | null>(null);
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
      const result = await saveAnalyticsDashboardLayout(
        storedAnalyticsLayout(legacy),
        null,
      );
      if (result.success) {
        setLayout(cloneSections(legacy));
        setLayoutConfigured(true);
        setUpdatedAt(result.updatedAt ?? null);
        removeLegacyLayout(storeId);
      } else {
        setSaveError(result.error ?? "Couldn't import the browser layout.");
      }
    });
  }, [allowed, layoutConfigured, storeId]);

  const editing = draft !== null;
  const sections = draft ?? layout;
  const placed = new Set(
    sections.flatMap((section) => section.items.map((item) => item.widgetId)),
  );
  const removed = allowed.filter((id) => !placed.has(id));

  const startEditing = () => {
    setSaveError(null);
    setResetRequested(false);
    setDraft(cloneSections(layout));
  };
  const cancelEditing = () => {
    setDraft(null);
    setLibrarySectionId(null);
    setResetRequested(false);
    setSaveError(null);
  };
  const save = () => {
    if (!draft || pending) return;
    const next = cloneSections(draft);
    setSaveError(null);
    startTransition(async () => {
      const result = resetRequested
        ? await resetAnalyticsDashboardLayout(updatedAt)
        : await saveAnalyticsDashboardLayout(
            storedAnalyticsLayout(next),
            updatedAt,
          );
      if (!result.success) {
        setSaveError(result.error ?? "Couldn't save the dashboard.");
        return;
      }
      const saved = resetRequested ? defaultAnalyticsSections(allowed) : next;
      setLayout(cloneSections(saved));
      setLayoutConfigured(!resetRequested);
      setUpdatedAt(result.updatedAt ?? null);
      setDraft(null);
      setLibrarySectionId(null);
      setResetRequested(false);
      removeLegacyLayout(storeId);
    });
  };
  const changeDraft = useCallback(
    (
      updater: (current: AnalyticsLayoutSection[]) => AnalyticsLayoutSection[],
    ) => {
      setResetRequested(false);
      setDraft((current) => (current ? updater(current) : current));
    },
    [],
  );
  const reset = () => {
    if (
      !window.confirm(
        "Reset this dashboard to StoreMink's current default layout?",
      )
    ) {
      return;
    }
    setDraft(defaultAnalyticsSections(allowed));
    setResetRequested(true);
    setLibrarySectionId(null);
    setSaveError(null);
  };
  const addSection = () => {
    changeDraft((current) => {
      if (current.length >= MAX_ANALYTICS_SECTIONS) return current;
      const suffix =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}`;
      return [
        ...current,
        {
          id: `section-${suffix}`,
          title: "New section",
          hidden: false,
          items: [],
        },
      ];
    });
  };
  const addCard = (sectionId: string, widgetId: WidgetId) => {
    changeDraft((current) =>
      current.map((section) =>
        section.id === sectionId
          ? {
              ...section,
              items: [
                ...section.items,
                {
                  widgetId,
                  size: availableWidgetSizes(widgetId)[0],
                },
              ],
            }
          : section,
      ),
    );
  };
  const removeCard = (widgetId: WidgetId) =>
    changeDraft((current) =>
      current.map((section) => ({
        ...section,
        items: section.items.filter((item) => item.widgetId !== widgetId),
      })),
    );
  const resizeCard = (widgetId: WidgetId, size: AnalyticsWidgetSize) =>
    changeDraft((current) =>
      current.map((section) => ({
        ...section,
        items: section.items.map((item) =>
          item.widgetId === widgetId ? { ...item, size } : item,
        ),
      })),
    );
  const moveCard = (widgetId: WidgetId, sectionId: string) =>
    changeDraft((current) => {
      const source = itemLocation(current, widgetId);
      if (!source) return current;
      const item = current[source.sectionIndex].items[source.itemIndex];
      return current.map((section) => ({
        ...section,
        items:
          section.id === sectionId
            ? [
                ...section.items.filter((entry) => entry.widgetId !== widgetId),
                item,
              ]
            : section.items.filter((entry) => entry.widgetId !== widgetId),
      }));
    });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const activeId = String(event.active.id);
      const overId = event.over ? String(event.over.id) : null;
      if (!overId || activeId === overId) return;
      changeDraft((current) => {
        const source = itemLocation(current, activeId);
        if (!source) return current;
        const moving = current[source.sectionIndex].items[source.itemIndex];
        const target = itemLocation(current, overId);
        const targetSectionId = overId.startsWith("section-drop:")
          ? overId.slice("section-drop:".length)
          : target
            ? current[target.sectionIndex].id
            : null;
        if (!targetSectionId) return current;

        const next = cloneSections(current);
        next[source.sectionIndex].items.splice(source.itemIndex, 1);
        const targetSectionIndex = next.findIndex(
          (section) => section.id === targetSectionId,
        );
        if (targetSectionIndex < 0) return current;
        let targetIndex = next[targetSectionIndex].items.length;
        if (target) {
          targetIndex = next[targetSectionIndex].items.findIndex(
            (item) => item.widgetId === overId,
          );
          if (targetIndex < 0)
            targetIndex = next[targetSectionIndex].items.length;
        }
        next[targetSectionIndex].items.splice(targetIndex, 0, moving);
        return next;
      });
    },
    [changeDraft],
  );

  const renderedSections = editing
    ? sections
    : sections.filter((section) => !section.hidden && section.items.length > 0);

  return (
    <>
      {editing ? (
        <div className="dash-savebar">
          <div className="dash-savebar-msg">
            <span className="dash-savebar-dot" aria-hidden />
            <span>
              Editing dashboard
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
            <button
              type="button"
              className="dash-an-btn"
              onClick={addSection}
              disabled={sections.length >= MAX_ANALYTICS_SECTIONS}
            >
              <Plus className="h-[15px] w-[15px]" />
              Add section
            </button>
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
          <div className="dash-sections is-editing">
            {renderedSections.map((section, index) => (
              <EditableSection
                key={section.id}
                section={section}
                index={index}
                total={sections.length}
                slots={slots}
                sections={sections}
                removed={removed}
                libraryOpen={librarySectionId === section.id}
                onLibraryOpen={() => setLibrarySectionId(section.id)}
                onLibraryClose={() => setLibrarySectionId(null)}
                onAdd={(widgetId) => addCard(section.id, widgetId)}
                onRemove={removeCard}
                onResize={resizeCard}
                onMoveCard={moveCard}
                onChange={(patch) =>
                  changeDraft((current) =>
                    current.map((entry) =>
                      entry.id === section.id ? { ...entry, ...patch } : entry,
                    ),
                  )
                }
                onDelete={() =>
                  changeDraft((current) =>
                    current.filter((entry) => entry.id !== section.id),
                  )
                }
                onMoveSection={(direction) =>
                  changeDraft((current) => {
                    const to = index + direction;
                    if (to < 0 || to >= current.length) return current;
                    const next = [...current];
                    const [moving] = next.splice(index, 1);
                    next.splice(to, 0, moving);
                    return next;
                  })
                }
              />
            ))}
          </div>
        </DndContext>
      ) : (
        <div className="dash-sections">
          {renderedSections.map((section) => (
            <section key={section.id} className="dash-section">
              <h2>{section.title}</h2>
              <div className="dash-canvas">
                {section.items.map((item) => (
                  <Widget
                    key={item.widgetId}
                    item={item}
                    node={slots[item.widgetId]}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {renderedSections.length === 0 ? (
        <div className="dash-canvas-empty">
          <p>Your dashboard is empty.</p>
          <button
            type="button"
            className="dash-an-btn"
            onClick={() => {
              if (!editing) startEditing();
              else addSection();
            }}
          >
            <Plus className="h-[15px] w-[15px]" />
            {editing ? "Add a section" : "Edit dashboard"}
          </button>
        </div>
      ) : null}
    </>
  );
}

function Widget({
  item,
  node,
}: {
  item: AnalyticsLayoutItem;
  node: ReactNode;
}) {
  return (
    <div className={`dash-widget size-${item.size}`}>
      <div className="dash-widget-body">{node}</div>
    </div>
  );
}

function EditableSection({
  section,
  index,
  total,
  slots,
  sections,
  removed,
  libraryOpen,
  onLibraryOpen,
  onLibraryClose,
  onAdd,
  onRemove,
  onResize,
  onMoveCard,
  onChange,
  onDelete,
  onMoveSection,
}: {
  section: AnalyticsLayoutSection;
  index: number;
  total: number;
  slots: Partial<Record<WidgetId, ReactNode>>;
  sections: AnalyticsLayoutSection[];
  removed: WidgetId[];
  libraryOpen: boolean;
  onLibraryOpen: () => void;
  onLibraryClose: () => void;
  onAdd: (id: WidgetId) => void;
  onRemove: (id: WidgetId) => void;
  onResize: (id: WidgetId, size: AnalyticsWidgetSize) => void;
  onMoveCard: (id: WidgetId, sectionId: string) => void;
  onChange: (patch: Partial<AnalyticsLayoutSection>) => void;
  onDelete: () => void;
  onMoveSection: (direction: -1 | 1) => void;
}) {
  return (
    <section
      className={`dash-section-editor${section.hidden ? " is-hidden" : ""}`}
    >
      <div className="dash-section-editor-head">
        <input
          value={section.title}
          maxLength={60}
          aria-label="Section title"
          onChange={(event) => onChange({ title: event.target.value })}
        />
        <div className="dash-section-editor-actions">
          <button
            type="button"
            onClick={() => onMoveSection(-1)}
            disabled={index === 0}
            aria-label={`Move ${section.title} up`}
          >
            <ChevronUp />
          </button>
          <button
            type="button"
            onClick={() => onMoveSection(1)}
            disabled={index === total - 1}
            aria-label={`Move ${section.title} down`}
          >
            <ChevronDown />
          </button>
          <button
            type="button"
            onClick={() => onChange({ hidden: !section.hidden })}
            aria-label={`${section.hidden ? "Show" : "Hide"} ${section.title}`}
          >
            {section.hidden ? <Eye /> : <EyeOff />}
          </button>
          <button
            type="button"
            onClick={onDelete}
            aria-label={`Delete ${section.title}`}
          >
            <Trash2 />
          </button>
          <div className="dash-lib-anchor">
            <button type="button" onClick={onLibraryOpen}>
              <Plus /> Add card
            </button>
            {libraryOpen ? (
              <SectionLibrary
                removed={removed}
                onAdd={onAdd}
                onClose={onLibraryClose}
              />
            ) : null}
          </div>
        </div>
      </div>
      <SectionGrid section={section}>
        {section.items.map((item) => (
          <SortableWidget
            key={item.widgetId}
            item={item}
            node={slots[item.widgetId]}
            sections={sections}
            currentSectionId={section.id}
            onRemove={() => onRemove(item.widgetId)}
            onResize={(size) => onResize(item.widgetId, size)}
            onMove={(sectionId) => onMoveCard(item.widgetId, sectionId)}
          />
        ))}
      </SectionGrid>
    </section>
  );
}

function SectionGrid({
  section,
  children,
}: {
  section: AnalyticsLayoutSection;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `section-drop:${section.id}`,
  });
  return (
    <SortableContext
      items={section.items.map((item) => item.widgetId)}
      strategy={rectSortingStrategy}
    >
      <div
        ref={setNodeRef}
        className={`dash-canvas${isOver ? " is-drop-target" : ""}`}
      >
        {children}
        {section.items.length === 0 ? (
          <div className="dash-section-empty">Drop or add a card here</div>
        ) : null}
      </div>
    </SortableContext>
  );
}

function SortableWidget({
  item,
  node,
  sections,
  currentSectionId,
  onRemove,
  onResize,
  onMove,
}: {
  item: AnalyticsLayoutItem;
  node: ReactNode;
  sections: AnalyticsLayoutSection[];
  currentSectionId: string;
  onRemove: () => void;
  onResize: (size: AnalyticsWidgetSize) => void;
  onMove: (sectionId: string) => void;
}) {
  const meta = WIDGETS[item.widgetId];
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.widgetId });
  return (
    <div
      ref={setNodeRef}
      className={`dash-widget size-${item.size}${isDragging ? " is-dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <div className="dash-widget-bar">
        <button
          type="button"
          className="dash-widget-grip"
          aria-label={`Move ${meta.title}`}
          {...attributes}
          {...listeners}
        >
          <GripVertical />
        </button>
        <select
          value={item.size}
          aria-label={`Size of ${meta.title}`}
          onChange={(event) =>
            onResize(event.target.value as AnalyticsWidgetSize)
          }
        >
          {availableWidgetSizes(item.widgetId).map((size) => (
            <option key={size} value={size}>
              {size[0].toUpperCase() + size.slice(1)}
            </option>
          ))}
        </select>
        {sections.length > 1 ? (
          <select
            value={currentSectionId}
            aria-label={`Section for ${meta.title}`}
            onChange={(event) => onMove(event.target.value)}
          >
            {sections.map((section) => (
              <option key={section.id} value={section.id}>
                {section.title}
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          className="dash-widget-x"
          aria-label={`Remove ${meta.title}`}
          onClick={onRemove}
        >
          <X />
        </button>
      </div>
      <div className="dash-widget-body">{node}</div>
    </div>
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
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const normalized = query.trim().toLowerCase();
  const matches = removed.filter((id) => {
    if (!normalized) return true;
    const meta = WIDGETS[id];
    return (
      meta.title.toLowerCase().includes(normalized) ||
      meta.description.toLowerCase().includes(normalized)
    );
  });
  return (
    <div className="dash-lib" ref={ref}>
      <div className="dash-lib-search">
        <Search />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search cards"
          aria-label="Search cards"
        />
      </div>
      <div className="dash-lib-list">
        {matches.length === 0 ? (
          <p className="dash-lib-empty">
            {removed.length === 0
              ? "Every available card is already placed."
              : "No cards match that search."}
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
                    onClick={() => {
                      onAdd(id);
                      onClose();
                    }}
                  >
                    <span>
                      <span className="dash-lib-item-title">
                        {WIDGETS[id].title}
                      </span>
                      <span className="dash-lib-item-desc">
                        {WIDGETS[id].description}
                      </span>
                    </span>
                    <Plus />
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

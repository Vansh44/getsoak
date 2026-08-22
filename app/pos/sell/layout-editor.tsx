"use client";

// "Edit layout" — arranging the till happens IN PLACE on the register, not on
// a separate page: the cart stays on the right, and a panel slides in on the
// left holding the catalogue. The manager drags a product out of the panel and
// into the grid, and drags tiles around the grid to reposition them.
//
// Touch is the primary input — this is a counter tablet. Hence a TouchSensor
// with a hold delay (so a finger can still SCROLL the panel), `touch-action:
// none` on every draggable (so the browser doesn't steal the gesture mid-drag),
// and tap-to-add as a first-class alternative to dragging.
//
// The layout stores only ids and order. Sold-out placement is NOT recorded —
// the register drops sold-out tiles to the end at render time (applyLayout), so
// a restock returns a product to the slot chosen here without anyone editing.

import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Loader2, Package, Plus, RotateCcw, Search, X } from "lucide-react";
import {
  itemKey,
  layoutKey,
  type CatalogItem,
  type LayoutEntry,
} from "@/lib/pos/catalog-index";

/** Drawer ids are prefixed so a drop can tell "add this" from "move this". */
const ADD_PREFIX = "add:";

export function LayoutEditMode({
  catalog,
  initial,
  saving,
  onSave,
  onReset,
  onClose,
}: {
  catalog: CatalogItem[];
  initial: LayoutEntry[];
  saving: boolean;
  onSave: (items: LayoutEntry[]) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<LayoutEntry[]>(initial);
  const [query, setQuery] = useState("");
  const [dragging, setDragging] = useState<CatalogItem | null>(null);

  const byKey = useMemo(
    () => new Map(catalog.map((i) => [itemKey(i), i])),
    [catalog],
  );
  const placedKeys = useMemo(() => new Set(entries.map(layoutKey)), [entries]);

  const placed = useMemo(
    () =>
      entries
        .map((e) => ({ key: layoutKey(e), item: byKey.get(layoutKey(e)) }))
        .filter((x): x is { key: string; item: CatalogItem } => !!x.item),
    [entries, byKey],
  );

  const q = query.trim().toLowerCase();
  const available = useMemo(
    () =>
      catalog.filter((i) => {
        if (!q) return true;
        const name = `${i.name} ${i.variantName ?? ""}`.toLowerCase();
        return (
          name.includes(q) ||
          (i.sku ?? "").toLowerCase().includes(q) ||
          (i.barcode ?? "").toLowerCase().includes(q)
        );
      }),
    [catalog, q],
  );

  const addAt = (i: CatalogItem, index?: number) => {
    const key = itemKey(i);
    if (placedKeys.has(key)) return;
    const entry = { productId: i.productId, variantId: i.variantId };
    setEntries((e) => {
      const next = [...e];
      next.splice(index ?? next.length, 0, entry);
      return next;
    });
  };
  const remove = (key: string) =>
    setEntries((e) => e.filter((x) => layoutKey(x) !== key));

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    // Press and hold to drag; a plain swipe still scrolls the panel, and a
    // plain tap still adds. Without the delay the list would be undraggable
    // AND unscrollable on a touchscreen.
    useSensor(TouchSensor, {
      activationConstraint: { delay: 180, tolerance: 8 },
    }),
  );

  const onDragStart = (ev: DragStartEvent) => {
    const id = String(ev.active.id);
    const key = id.startsWith(ADD_PREFIX) ? id.slice(ADD_PREFIX.length) : id;
    setDragging(byKey.get(key) ?? null);
  };

  const onDragEnd = (ev: DragEndEvent) => {
    setDragging(null);
    const { active, over } = ev;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);

    // Dragged out of the catalogue panel: insert where it was dropped, or
    // append when dropped on empty grid space.
    if (activeId.startsWith(ADD_PREFIX)) {
      const item = byKey.get(activeId.slice(ADD_PREFIX.length));
      if (!item) return;
      const keys = entries.map(layoutKey);
      const at = keys.indexOf(overId);
      addAt(item, at < 0 ? undefined : at);
      return;
    }

    // Reordering within the grid.
    if (activeId === overId) return;
    setEntries((e) => {
      const keys = e.map(layoutKey);
      const from = keys.indexOf(activeId);
      const to = keys.indexOf(overId);
      return from < 0 || to < 0 ? e : arrayMove(e, from, to);
    });
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Contextual bar — the register's own header stays put above it. */}
        <div className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
          <div className="text-sm">
            <span className="font-semibold">Editing layout</span>
            <span className="text-[var(--pos-ink-2)]">
              {" · "}
              {placed.length} of {catalog.length} on the till
              {placed.length === 0 && " — empty shows everything"}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onReset}
              disabled={saving}
              title="Show every product again"
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-[var(--pos-ink-2)] transition-colors hover:bg-[var(--pos-surface-2)] hover:text-[var(--pos-ink)] disabled:opacity-40"
            >
              <RotateCcw className="h-4 w-4" strokeWidth={2} />
              Reset
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-lg bg-[var(--pos-surface-2)] px-3 py-1.5 text-sm font-medium transition-colors hover:bg-[var(--pos-surface-3)] disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onSave(entries)}
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold transition-colors hover:bg-emerald-500 disabled:opacity-40"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Save
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 gap-3">
          {/* The slide-in catalogue panel. */}
          <aside className="sm-layout-drawer flex w-56 shrink-0 flex-col rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface-2)] md:w-64">
            <div className="relative shrink-0 p-2">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--pos-ink-3)]" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search…"
                className="w-full rounded-lg border border-[var(--pos-border)] bg-[var(--pos-surface)] py-2 pl-8 pr-2 text-sm outline-none placeholder:text-[var(--pos-ink-3)] focus:border-[var(--pos-border-strong)]"
              />
            </div>
            <p className="shrink-0 px-3 pb-1.5 text-[11px] leading-tight text-[var(--pos-ink-3)]">
              Tap to add, or hold and drag onto the grid.
            </p>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {available.map((i) => (
                <DrawerItem
                  key={itemKey(i)}
                  item={i}
                  placed={placedKeys.has(itemKey(i))}
                  onAdd={() => addAt(i)}
                />
              ))}
              {available.length === 0 && (
                <p className="py-6 text-center text-sm text-[var(--pos-ink-3)]">
                  No products match.
                </p>
              )}
            </div>
          </aside>

          {/* The till grid itself — the same shape the cashier will see. */}
          <GridDropArea empty={placed.length === 0}>
            <SortableContext
              items={placed.map((p) => p.key)}
              strategy={rectSortingStrategy}
            >
              {placed.map(({ key, item }) => (
                <SortableTile
                  key={key}
                  id={key}
                  item={item}
                  onRemove={() => remove(key)}
                />
              ))}
            </SortableContext>
          </GridDropArea>
        </div>
      </div>

      {/* Follows the finger, so it's clear what is being dropped where. */}
      <DragOverlay dropAnimation={null}>
        {dragging && (
          <div className="pointer-events-none flex items-center gap-2 rounded-xl border border-emerald-400/60 bg-[var(--pos-bg)] p-2 shadow-2xl">
            <Thumb item={dragging} className="h-10 w-10 rounded-lg" />
            <span className="max-w-[10rem] truncate text-sm font-medium">
              {dragging.name}
            </span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

function GridDropArea({
  empty,
  children,
}: {
  empty: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: "sm-layout-grid" });
  return (
    <div
      ref={setNodeRef}
      className={`min-h-0 flex-1 overflow-y-auto rounded-xl border-2 border-dashed p-2 transition-colors ${
        isOver
          ? "border-emerald-500/60 bg-emerald-500/5"
          : "border-[var(--pos-border)]"
      }`}
    >
      {empty ? (
        <div className="flex h-full min-h-40 items-center justify-center px-6 text-center">
          <p className="max-w-xs text-sm text-[var(--pos-ink-3)]">
            Drag products here to build the till grid. Leave it empty and the
            register keeps showing every product.
          </p>
        </div>
      ) : (
        <div className="grid auto-rows-max grid-cols-2 gap-2 lg:grid-cols-3 xl:grid-cols-4">
          {children}
        </div>
      )}
    </div>
  );
}

function DrawerItem({
  item,
  placed,
  onAdd,
}: {
  item: CatalogItem;
  placed: boolean;
  onAdd: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `${ADD_PREFIX}${itemKey(item)}`,
    disabled: placed,
  });
  return (
    <div
      ref={setNodeRef}
      // Without this the browser scrolls the panel instead of dragging.
      style={{ touchAction: "none" }}
      className={isDragging ? "opacity-40" : ""}
    >
      <button
        type="button"
        onClick={onAdd}
        disabled={placed}
        {...attributes}
        {...listeners}
        className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-[var(--pos-surface-2)] disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <Thumb item={item} className="h-8 w-8 shrink-0 rounded-md" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm leading-tight">
            {item.name}
          </span>
          {item.variantName && (
            <span className="block truncate text-xs text-[var(--pos-ink-2)]">
              {item.variantName}
            </span>
          )}
        </span>
        {placed ? (
          <span className="shrink-0 text-[11px] text-[var(--pos-ink-3)]">
            Added
          </span>
        ) : (
          <Plus className="h-4 w-4 shrink-0 text-[var(--pos-ink-3)]" />
        )}
      </button>
    </div>
  );
}

function Thumb({
  item,
  className = "",
}: {
  item: CatalogItem;
  className?: string;
}) {
  return (
    <span
      className={`flex items-center justify-center overflow-hidden bg-[var(--pos-surface)] ${className}`}
    >
      {item.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={item.image}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
        />
      ) : (
        <Package
          className="h-4 w-4 text-[var(--pos-ink-3)]"
          strokeWidth={1.5}
        />
      )}
    </span>
  );
}

function SortableTile({
  id,
  item,
  onRemove,
}: {
  id: string;
  item: CatalogItem;
  onRemove: () => void;
}) {
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
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        touchAction: "none",
      }}
      {...attributes}
      {...listeners}
      className={`relative flex cursor-grab flex-col rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)] p-2 active:cursor-grabbing ${
        isDragging ? "z-10 opacity-50" : ""
      }`}
    >
      <Thumb item={item} className="mb-2 aspect-square w-full rounded-lg" />
      <span className="line-clamp-2 text-sm font-medium">{item.name}</span>
      {item.variantName && (
        <span className="text-xs text-[var(--pos-ink-2)]">
          {item.variantName}
        </span>
      )}
      {/* Sits above the drag listeners so removing stays a plain tap. */}
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onRemove}
        aria-label={`Remove ${item.name}`}
        className="absolute right-1 top-1 rounded-lg bg-black/60 p-1 text-white/80 transition-colors hover:bg-black/80 hover:text-white"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

"use client";

import { useState } from "react";
import {
  ChevronDown,
  Eye,
  EyeOff,
  FileText,
  GripVertical,
  Home,
  Layout,
  Plus,
  Palette,
} from "lucide-react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { navIcons } from "../nav-icons";
import {
  SECTION_TYPE_META,
  summarizeSection,
} from "@/lib/homepage/section-types";
import type { PageSectionItem } from "@/lib/sections/registry";
import type { PageListItem } from "@/app/actions/page-actions";

// Left panel: page switcher + Header (theme) + draggable section outline +
// Footer (theme) + Add Section — the Unizap-style structure column.
export function OutlinePanel({
  pages,
  selectedPageId,
  onSelectPage,
  onNewPage,
  sections,
  selectedSectionId,
  canvasHoverId,
  hiddenSectionIds,
  onSelectSection,
  onHoverSection,
  onToggleSection,
  onReorder,
  onAddSection,
  chromeTarget,
  onSelectChrome,
  loading,
}: {
  pages: PageListItem[];
  selectedPageId: string | null;
  onSelectPage: (id: string) => void;
  onNewPage: () => void;
  sections: PageSectionItem[] | null;
  selectedSectionId: string | null;
  /** Section hovered in the CANVAS — highlighted here for orientation. */
  canvasHoverId: string | null;
  /** Section ids the preview reported as NOT rendering (empty/no data). */
  hiddenSectionIds: Set<string>;
  onSelectSection: (id: string) => void;
  /** Row hover → highlight the block in the canvas (null on leave). */
  onHoverSection: (id: string | null) => void;
  onToggleSection: (id: string) => void;
  onReorder: (activeId: string, overId: string) => void;
  onAddSection: () => void;
  /** Which global area (header/footer) the inspector is editing, if any. */
  chromeTarget: "header" | "footer" | "brand" | null;
  onSelectChrome: (target: "header" | "footer" | "brand") => void;
  /** A page is being opened. Distinct from "no page chosen". */
  loading: boolean;
}) {
  const [switcherOpen, setSwitcherOpen] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const sorted = [...pages].sort((a, b) =>
    a.slug === "" ? -1 : b.slug === "" ? 1 : 0,
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      onReorder(String(active.id), String(over.id));
    }
  }

  return (
    <aside className="sm-builder-pages">
      {/* Pages — an always-visible rail, not a dropdown.
          It used to be a menu that OVERLAID the section outline, so choosing a
          page meant covering the thing you were about to edit and losing your
          place in it. A list that pushes content down costs a little height
          and takes nothing away. */}
      <div className="sm-builder-pagesrail">
        <button
          className="sm-builder-rail-head"
          onClick={() => setSwitcherOpen((o) => !o)}
          aria-expanded={switcherOpen}
        >
          <span>Pages</span>
          <span className="sm-builder-rail-count">{sorted.length}</span>
          <ChevronDown
            className={`ml-auto h-3.5 w-3.5 opacity-50 transition-transform ${
              switcherOpen ? "" : "-rotate-90"
            }`}
          />
        </button>
        {switcherOpen && (
          <div className="sm-builder-rail-list">
            {sorted.map((p) => {
              const isHome = p.slug === "";
              return (
                <button
                  key={p.id}
                  className={`sm-builder-pageitem ${selectedPageId === p.id ? "active" : ""}`}
                  onClick={() => onSelectPage(p.id)}
                >
                  {isHome ? (
                    <Home className="h-4 w-4 shrink-0 opacity-60" />
                  ) : (
                    <FileText className="h-4 w-4 shrink-0 opacity-60" />
                  )}
                  <span className="sm-builder-pageitem-main">
                    <span className="sm-builder-pageitem-title">
                      {isHome ? "Home" : p.title || p.slug}
                    </span>
                    <span className="sm-builder-pageitem-slug">
                      {isHome ? "Homepage" : `/${p.slug}`}
                    </span>
                  </span>
                  <span
                    className={`sm-builder-dot ${p.status === "published" ? "is-live" : ""}`}
                    title={p.status}
                  />
                </button>
              );
            })}
            <button
              className="sm-builder-pageitem sm-builder-newpage"
              onClick={onNewPage}
            >
              <Plus className="h-4 w-4 shrink-0" />
              <span className="sm-builder-pageitem-main">
                <span className="sm-builder-pageitem-title">New page</span>
              </span>
            </button>
          </div>
        )}
      </div>

      {/* Header — a global section, edited right here. It used to be a Link
          out to /dashboard/navigation, which threw the merchant into a
          different page with a different form and no preview. */}
      <div className="sm-builder-outline">
        <button
          type="button"
          className={`sm-builder-themerow${
            chromeTarget === "header" ? " is-selected" : ""
          }`}
          onClick={() => onSelectChrome("header")}
        >
          <Layout className="h-4 w-4 opacity-50" />
          <span>
            <span className="sm-builder-themerow-title">Header</span>
            <span className="sm-builder-themerow-sub">
              Menu, search &amp; cart
            </span>
          </span>
        </button>

        <div className="sm-builder-outline-label">Sections</div>

        {sections === null && (
          <p className="sm-builder-empty">
            {loading ? "Opening…" : "Select a page to see its sections."}
          </p>
        )}
        {sections?.length === 0 && (
          <p className="sm-builder-empty">
            No sections yet — add your first one below.
          </p>
        )}

        {sections && sections.length > 0 && (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={sections.map((s) => s.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="sm-builder-outline-list">
                {sections.map((s) => (
                  <SortableSectionRow
                    key={s.id}
                    section={s}
                    selected={selectedSectionId === s.id}
                    canvasHover={canvasHoverId === s.id}
                    hiddenOnPage={hiddenSectionIds.has(s.id)}
                    onSelect={() => onSelectSection(s.id)}
                    onHover={onHoverSection}
                    onToggle={() => onToggleSection(s.id)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}

        {sections !== null && (
          <button className="sm-builder-addsection" onClick={onAddSection}>
            <Plus className="h-4 w-4" /> Add Section
          </button>
        )}

        {/* Brand — the third global section: how the whole site looks. */}
        <button
          type="button"
          className={`sm-builder-themerow${
            chromeTarget === "brand" ? " is-selected" : ""
          }`}
          onClick={() => onSelectChrome("brand")}
        >
          <Palette className="h-4 w-4 opacity-50" />
          <span>
            <span className="sm-builder-themerow-title">Brand</span>
            <span className="sm-builder-themerow-sub">
              Colour, logo &amp; layouts
            </span>
          </span>
        </button>

        {/* Footer — likewise a global section. */}
        <button
          type="button"
          className={`sm-builder-themerow${
            chromeTarget === "footer" ? " is-selected" : ""
          }`}
          onClick={() => onSelectChrome("footer")}
        >
          <Layout className="h-4 w-4 rotate-180 opacity-50" />
          <span>
            <span className="sm-builder-themerow-title">Footer</span>
            <span className="sm-builder-themerow-sub">
              Columns, newsletter &amp; legal
            </span>
          </span>
        </button>
      </div>
    </aside>
  );
}

function SortableSectionRow({
  section,
  selected,
  canvasHover,
  hiddenOnPage,
  onSelect,
  onHover,
  onToggle,
}: {
  section: PageSectionItem;
  selected: boolean;
  canvasHover: boolean;
  hiddenOnPage: boolean;
  onSelect: () => void;
  onHover: (id: string | null) => void;
  onToggle: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: section.id });

  const meta = SECTION_TYPE_META[section.type];
  const Icon = navIcons[meta.icon as keyof typeof navIcons];

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : undefined,
        zIndex: isDragging ? 5 : undefined,
      }}
      className={`sm-builder-sectionitem ${section.enabled ? "" : "is-off"} ${selected ? "is-selected" : ""} ${canvasHover ? "is-canvas-hover" : ""}`}
      onClick={onSelect}
      onMouseEnter={() => onHover(section.id)}
      onMouseLeave={() => onHover(null)}
    >
      <button
        className="sm-builder-grip"
        title="Drag to reorder"
        {...attributes}
        {...listeners}
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <span className="sm-builder-sectionicon">
        {Icon ? <Icon className="h-4 w-4" /> : null}
      </span>
      <span className="sm-builder-sectionmain">
        <span className="sm-builder-sectiontype">
          {meta.label}
          {hiddenOnPage && section.enabled && (
            <span
              className="sm-builder-hiddenbadge"
              title="Not visible on the page — it has nothing to show yet (e.g. no products/content)."
            >
              empty
            </span>
          )}
        </span>
        <span className="sm-builder-sectionsummary">
          {summarizeSection(section)}
        </span>
      </span>
      <button
        className="sm-builder-eyebtn"
        title={section.enabled ? "Hide section" : "Show section"}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
      >
        {section.enabled ? (
          <Eye className="h-4 w-4" />
        ) : (
          <EyeOff className="h-4 w-4" />
        )}
      </button>
    </div>
  );
}

"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  MoreHorizontal,
  Palette,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { deleteCardColor } from "@/app/actions/color-actions";
import { ColorEditorDialog } from "./color-editor-dialog";
import type { CardColor } from "./page";

type Props = {
  colors: CardColor[];
  canManage?: boolean;
};

export function ColorsManagementView({ colors, canManage = true }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [search, setSearch] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<CardColor | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<CardColor | null>(null);

  const filtered = useMemo(() => {
    if (!search.trim()) return colors;
    const q = search.toLowerCase();
    return colors.filter(
      (c) =>
        c.name.toLowerCase().includes(q) || c.hex.toLowerCase().includes(q),
    );
  }, [colors, search]);

  const handleDelete = () => {
    if (!deleteTarget) return;
    startTransition(async () => {
      const result = await deleteCardColor(deleteTarget.id);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Colour deleted");
        setDeleteTarget(null);
        router.refresh();
      }
    });
  };

  const openEditor = (color?: CardColor) => {
    setEditing(color ?? null);
    setEditorOpen(true);
  };

  const closeEditor = () => {
    setEditorOpen(false);
    setEditing(null);
  };

  const handleSaved = () => {
    closeEditor();
    router.refresh();
  };

  return (
    <div className="dash-page-enter">
      <header className="dash-page-header row">
        <div>
          <h1>Colours</h1>
          <p>Palette of background shades for storefront product cards</p>
        </div>
        {canManage && (
          <button
            className="dash-btn dash-btn-primary shrink-0"
            onClick={() => openEditor()}
          >
            <Plus className="h-4 w-4" />
            New colour
          </button>
        )}
      </header>

      <div className="dash-toolbar">
        <div className="dash-toolbar-actions ml-auto">
          <label className="dash-search-bar">
            <Search className="h-4 w-4 shrink-0 opacity-50" />
            <input
              type="text"
              placeholder="Search colours..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
        </div>
      </div>

      <div className="dash-card">
        <div className="dash-card-header">
          <div>
            <div className="dash-card-title">Colours</div>
            <div className="dash-card-sub">
              {filtered.length} {filtered.length === 1 ? "colour" : "colours"}
            </div>
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="dash-empty">
            <span className="dash-empty-icon">
              <Palette className="h-5 w-5" />
            </span>
            <div className="dash-empty-title">
              {search ? "No colours match your search" : "No colours yet"}
            </div>
            <p className="dash-empty-text">
              {search
                ? "Try a different search term."
                : "Add your first shade to use as a product card background."}
            </p>
            {!search && canManage && (
              <button
                className="dash-btn dash-btn-primary"
                onClick={() => openEditor()}
              >
                <Plus className="h-4 w-4" />
                New colour
              </button>
            )}
          </div>
        ) : (
          <table className="dash-table dash-table-wide">
            <thead>
              <tr>
                <th className="w-14">Swatch</th>
                <th>Name</th>
                <th>Hex</th>
                <th>Used by</th>
                <th>Order</th>
                {canManage && <th className="dash-col-actions">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id}>
                  <td>
                    <div
                      className="h-10 w-10 shrink-0 rounded-lg border border-[#e5e7eb]"
                      style={{ background: c.hex }}
                    />
                  </td>
                  <td>
                    <div className="dash-cell-title">{c.name}</div>
                  </td>
                  <td>
                    <span className="dash-cell-sub mono">{c.hex}</span>
                  </td>
                  <td className="text-muted">
                    {c.product_count ?? 0}{" "}
                    {c.product_count === 1 ? "product" : "products"}
                  </td>
                  <td className="text-dim font-mono-dash">{c.sort_order}</td>
                  {canManage && (
                    <td className="dash-col-actions">
                      <DropdownMenu>
                        <DropdownMenuTrigger className="dash-row-menu">
                          <MoreHorizontal className="h-4 w-4" />
                          <span className="sr-only">Actions</span>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          className="min-w-[180px]"
                        >
                          <DropdownMenuItem
                            className="cursor-pointer"
                            onClick={() => openEditor(c)}
                          >
                            <Pencil className="mr-2 h-4 w-4" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            className="cursor-pointer"
                            onClick={() => setDeleteTarget(c)}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Delete Confirmation */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Delete colour</DialogTitle>
            <DialogDescription>
              Delete &ldquo;{deleteTarget?.name}&rdquo;? Products already using
              this shade keep their colour — it&rsquo;s just removed from the
              dropdown.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isPending}
            >
              {isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ColorEditorDialog
        open={editorOpen}
        color={editing}
        onClose={closeEditor}
        onSaved={handleSaved}
      />
    </div>
  );
}

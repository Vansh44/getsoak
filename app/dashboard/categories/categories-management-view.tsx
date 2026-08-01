"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import Image from "next/image";
import {
  FolderTree,
  ImageIcon,
  MoreHorizontal,
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
import { deleteCategory } from "@/app/actions/category-actions";
import { CategoryEditorDialog } from "./category-editor-dialog";
import type { Category } from "./page";

type Props = {
  categories: Category[];
  canManage?: boolean;
};

export function CategoriesManagementView({
  categories,
  canManage = true,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [search, setSearch] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Category | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Category | null>(null);

  const filtered = useMemo(() => {
    if (!search.trim()) return categories;
    const q = search.toLowerCase();
    return categories.filter(
      (c) =>
        c.name.toLowerCase().includes(q) || c.slug.toLowerCase().includes(q),
    );
  }, [categories, search]);

  const handleDelete = () => {
    if (!deleteTarget) return;
    startTransition(async () => {
      const result = await deleteCategory(deleteTarget.id);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Category deleted");
        setDeleteTarget(null);
        router.refresh();
      }
    });
  };

  const openEditor = (category?: Category) => {
    setEditing(category ?? null);
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
          <h1>Categories</h1>
          <p>Organize your storefront catalog into categories</p>
        </div>
        {canManage && (
          <button
            className="dash-btn dash-btn-primary shrink-0"
            onClick={() => openEditor()}
          >
            <Plus className="h-4 w-4" />
            New category
          </button>
        )}
      </header>

      <div className="dash-card flex flex-col">
        <div className="dash-toolbar px-5 pt-4 pb-2 border-b border-[var(--dash-border)] mb-0 flex flex-col gap-4">
          <div className="dash-toolbar-actions w-full flex justify-between">
            <div></div>
            <label className="dash-search-bar">
              <Search className="h-4 w-4 shrink-0 opacity-50" />
              <input
                type="text"
                placeholder="Search categories..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="dash-empty">
            <span className="dash-empty-icon">
              <FolderTree className="h-5 w-5" />
            </span>
            <div className="dash-empty-title">
              {search ? "No categories match your search" : "No categories yet"}
            </div>
            <p className="dash-empty-text">
              {search
                ? "Try a different search term."
                : "Create your first category to start organizing products."}
            </p>
            {!search && canManage && (
              <button
                className="dash-btn dash-btn-primary"
                onClick={() => openEditor()}
              >
                <Plus className="h-4 w-4" />
                New category
              </button>
            )}
          </div>
        ) : (
          <table className="dash-table dash-table-wide">
            <thead>
              <tr>
                <th className="w-14">Image</th>
                <th>Name</th>
                <th>Products</th>
                <th>Order</th>
                <th>Status</th>
                {canManage && <th className="dash-col-actions">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id}>
                  <td>
                    {c.image_url ? (
                      <div className="dash-thumb">
                        <Image
                          src={c.image_url}
                          alt={c.name}
                          fill
                          sizes="48px"
                          className="object-cover"
                        />
                      </div>
                    ) : (
                      <div className="dash-thumb dash-thumb-empty">
                        <ImageIcon className="h-4 w-4" />
                      </div>
                    )}
                  </td>
                  <td>
                    <div className="dash-cell-title">{c.name}</div>
                    <div className="dash-cell-sub mono">/{c.slug}</div>
                  </td>
                  <td className="text-muted">
                    {c.product_count ?? 0}{" "}
                    {c.product_count === 1 ? "product" : "products"}
                  </td>
                  <td className="text-dim font-mono-dash">{c.sort_order}</td>
                  <td>
                    <span
                      className={`dash-badge ${
                        c.status === "active"
                          ? "dash-badge-green"
                          : "dash-badge-grey"
                      }`}
                    >
                      {c.status === "active" ? "Active" : "Hidden"}
                    </span>
                  </td>
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
            <DialogTitle>Delete category</DialogTitle>
            <DialogDescription>
              Delete &ldquo;{deleteTarget?.name}&rdquo;? Products in this
              category won&rsquo;t be deleted — they&rsquo;ll become
              uncategorized.
            </DialogDescription>
          </DialogHeader>
          {(deleteTarget?.product_count ?? 0) > 0 && (
            <div className="py-2">
              <p className="text-sm text-[var(--dash-amber)]">
                {deleteTarget?.product_count} product
                {deleteTarget?.product_count === 1 ? "" : "s"} will become
                uncategorized.
              </p>
            </div>
          )}
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

      <CategoryEditorDialog
        open={editorOpen}
        category={editing}
        onClose={closeEditor}
        onSaved={handleSaved}
      />
    </div>
  );
}

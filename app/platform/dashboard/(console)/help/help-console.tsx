"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Plus,
  Pencil,
  Trash2,
  Eye,
  EyeOff,
  ExternalLink,
  FolderCog,
} from "lucide-react";
import {
  deleteHelpArticle,
  setHelpArticleStatus,
  createHelpCategory,
  updateHelpCategory,
  deleteHelpCategory,
} from "@/app/actions/help-actions";
import type { HelpArticleCard, HelpCategory } from "@/lib/help/types";
import { HELP_ICON_NAMES } from "@/app/help/components/category-icon";
import "./help-admin.css";

export function HelpConsole({
  initialArticles,
  initialCategories,
  helpBaseUrl,
}: {
  initialArticles: HelpArticleCard[];
  initialCategories: HelpCategory[];
  helpBaseUrl: string;
}) {
  const router = useRouter();
  // Source of truth is the server prop — mutations call router.refresh(), which
  // re-runs the (force-dynamic) page and streams fresh props in. (Holding these
  // in useState would freeze the initial list and require a manual full reload.)
  const articles = initialArticles;
  const categories = initialCategories;
  const [q, setQ] = useState("");
  const [catFilter, setCatFilter] = useState("");
  const [showCats, setShowCats] = useState(false);
  const [pending, start] = useTransition();

  const catById = new Map(categories.map((c) => [c.id, c]));

  const filtered = articles.filter((a) => {
    if (catFilter && a.categoryId !== catFilter) return false;
    if (q && !a.title.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  function toggleStatus(a: HelpArticleCard) {
    start(async () => {
      const res = await setHelpArticleStatus(
        a.id,
        a.status === "published" ? "draft" : "published",
      );
      if (res.error) toast.error(res.error);
      else {
        toast.success(a.status === "published" ? "Unpublished" : "Published");
        router.refresh();
      }
    });
  }

  function remove(a: HelpArticleCard) {
    if (!confirm(`Delete “${a.title}”? This cannot be undone.`)) return;
    start(async () => {
      const res = await deleteHelpArticle(a.id);
      if (res.error) toast.error(res.error);
      else {
        toast.success("Deleted");
        router.refresh();
      }
    });
  }

  return (
    <div className="hc-admin">
      <div className="hca-topline">
        <div>
          <h1>Help Centre</h1>
          <p>
            Manage the docs at{" "}
            <a href={helpBaseUrl} target="_blank" rel="noopener">
              {helpBaseUrl.replace(/^https?:\/\//, "")}
            </a>
          </p>
        </div>
        <div className="hca-topline-actions">
          <button className="hca-btn ghost" onClick={() => setShowCats(true)}>
            <FolderCog size={16} /> Categories
          </button>
          <Link className="hca-btn primary" href="/dashboard/help/new">
            <Plus size={16} /> New article
          </Link>
        </div>
      </div>

      <div className="hca-filters">
        <input
          placeholder="Search articles…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          value={catFilter}
          onChange={(e) => setCatFilter(e.target.value)}
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
      </div>

      {filtered.length === 0 ? (
        <div className="hca-empty">
          No articles yet. Click <b>New article</b> to write your first doc.
        </div>
      ) : (
        <table className="hca-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Category</th>
              <th>Status</th>
              <th>Views</th>
              <th>Helpful</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((a) => {
              const cat = a.categoryId ? catById.get(a.categoryId) : undefined;
              return (
                <tr key={a.id}>
                  <td className="t-title">{a.title}</td>
                  <td>{cat?.title ?? <span className="muted">—</span>}</td>
                  <td>
                    <span className={`badge ${a.status}`}>{a.status}</span>
                  </td>
                  <td>{a.viewCount}</td>
                  <td className="muted">
                    {/* helpful counts not on the card query — shown in editor */}
                    —
                  </td>
                  <td className="t-actions">
                    <a
                      href={
                        a.status === "published"
                          ? `${helpBaseUrl}/help/${cat?.slug ?? "_"}/${a.slug}`
                          : `${helpBaseUrl}/help/${cat?.slug ?? "_"}/${a.slug}?preview=1`
                      }
                      target="_blank"
                      rel="noopener"
                      title={
                        a.status === "published"
                          ? "View live"
                          : "Preview draft (operators only)"
                      }
                    >
                      <ExternalLink size={16} />
                    </a>
                    <button
                      title={a.status === "published" ? "Unpublish" : "Publish"}
                      disabled={pending}
                      onClick={() => toggleStatus(a)}
                    >
                      {a.status === "published" ? (
                        <EyeOff size={16} />
                      ) : (
                        <Eye size={16} />
                      )}
                    </button>
                    <Link href={`/dashboard/help/${a.id}`} title="Edit">
                      <Pencil size={16} />
                    </Link>
                    <button
                      title="Delete"
                      className="danger"
                      disabled={pending}
                      onClick={() => remove(a)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {showCats && (
        <CategoryManager
          categories={categories}
          onClose={() => setShowCats(false)}
          onChanged={() => router.refresh()}
        />
      )}
    </div>
  );
}

// ─── Category manager (inline dialog) ───────────────────────────────────────

function CategoryManager({
  categories,
  onClose,
  onChanged,
}: {
  categories: HelpCategory[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [title, setTitle] = useState("");
  const [icon, setIcon] = useState(HELP_ICON_NAMES[0]);
  const [description, setDescription] = useState("");
  const [pending, start] = useTransition();

  function add() {
    if (!title.trim()) return;
    start(async () => {
      const res = await createHelpCategory({
        title,
        slug: "",
        description,
        icon,
      });
      if (res.error) toast.error(res.error);
      else {
        toast.success("Category added");
        setTitle("");
        setDescription("");
        onChanged();
      }
    });
  }

  function rename(c: HelpCategory) {
    const next = prompt("Category title", c.title);
    if (next === null || !next.trim()) return;
    start(async () => {
      const res = await updateHelpCategory(c.id, {
        title: next,
        slug: "",
        description: c.description ?? "",
        icon: c.icon ?? "",
      });
      if (res.error) toast.error(res.error);
      else onChanged();
    });
  }

  function remove(c: HelpCategory) {
    if (!confirm(`Delete “${c.title}”? Its articles become uncategorised.`))
      return;
    start(async () => {
      const res = await deleteHelpCategory(c.id);
      if (res.error) toast.error(res.error);
      else onChanged();
    });
  }

  return (
    <div className="hca-overlay" role="dialog" aria-modal="true">
      <div className="hca-modal small">
        <div className="hca-head">
          <strong>Categories</strong>
          <button className="hca-btn ghost" onClick={onClose}>
            Done
          </button>
        </div>
        <div className="hca-cat-body">
          <div className="hca-cat-add">
            <input
              placeholder="New category title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <select value={icon} onChange={(e) => setIcon(e.target.value)}>
              {HELP_ICON_NAMES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <input
              placeholder="Description (optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <button
              className="hca-btn primary"
              disabled={pending}
              onClick={add}
            >
              Add
            </button>
          </div>
          <ul className="hca-cat-list">
            {categories.map((c) => (
              <li key={c.id}>
                <span>
                  <b>{c.title}</b> <span className="muted">/{c.slug}</span>
                </span>
                <span className="hca-cat-actions">
                  <button onClick={() => rename(c)}>
                    <Pencil size={15} />
                  </button>
                  <button className="danger" onClick={() => remove(c)}>
                    <Trash2 size={15} />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

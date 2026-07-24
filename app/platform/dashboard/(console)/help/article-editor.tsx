"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useEditor, EditorContent } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import ImageExtension from "@tiptap/extension-image";
import Underline from "@tiptap/extension-underline";
import TextAlign from "@tiptap/extension-text-align";
import Placeholder from "@tiptap/extension-placeholder";
import { TableKit } from "@tiptap/extension-table";
import {
  Heading2,
  Heading3,
  Bold,
  Italic,
  Underline as UnderlineIcon,
  List,
  ListOrdered,
  Quote,
  Minus,
  Link as LinkIcon,
  Image as ImageIcon,
  Table as TableIcon,
  Sparkles,
  ArrowLeft,
} from "lucide-react";
import { uploadImage } from "@/lib/storage/uploads";
import { slugify } from "@/lib/slug";
import {
  createHelpArticle,
  updateHelpArticle,
  getHelpArticleForEditor,
  runHelpAiCommand,
  type HelpArticleInput,
} from "@/app/actions/help-actions";
import type { HelpCategory, HelpStatus } from "@/lib/help/types";
import "./help-admin.css";

type Props = {
  articleId: string | null; // null = new
  categories: HelpCategory[];
};

const BACK_HREF = "/dashboard/help";

const Btn = ({
  onClick,
  active,
  title,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  title: string;
  children: React.ReactNode;
}) => (
  <button
    type="button"
    className="hca-tb"
    data-active={active ? "true" : "false"}
    title={title}
    onMouseDown={(e) => e.preventDefault()}
    onClick={onClick}
  >
    {children}
  </button>
);

export function ArticleEditor({ articleId, categories }: Props) {
  const router = useRouter();
  const close = () => router.push(BACK_HREF);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [categoryId, setCategoryId] = useState<string>(categories[0]?.id ?? "");
  const [excerpt, setExcerpt] = useState("");
  const [status, setStatus] = useState<HelpStatus>("draft");
  const [seoTitle, setSeoTitle] = useState("");
  const [seoDescription, setSeoDescription] = useState("");
  const [loading, setLoading] = useState(Boolean(articleId));
  const [aiBusy, setAiBusy] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [messages, setMessages] = useState<
    { role: "user" | "ai"; text: string }[]
  >([]);
  const [saving, startSave] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3] } }),
      Underline,
      Link.configure({ openOnClick: false }),
      ImageExtension,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      TableKit.configure({ table: { resizable: true } }),
      Placeholder.configure({
        placeholder: "Write the article, or ask AI below to draft it…",
      }),
    ],
    editorProps: { attributes: { class: "hca-prose" } },
    content: "",
  });

  // Load existing article.
  useEffect(() => {
    if (!articleId) return;
    let cancelled = false;
    (async () => {
      const a = await getHelpArticleForEditor(articleId);
      if (cancelled || !a) {
        if (!cancelled) toast.error("Could not load the article.");
        return;
      }
      setTitle(a.title);
      setSlug(a.slug);
      setSlugTouched(true);
      setCategoryId(a.categoryId ?? "");
      setExcerpt(a.excerpt ?? "");
      setStatus(a.status);
      setSeoTitle(a.seoTitle ?? "");
      setSeoDescription(a.seoDescription ?? "");
      editor?.commands.setContent(a.body ?? "");
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [articleId, editor]);

  // Auto-slug from title until the field is edited manually.
  function onTitleChange(value: string) {
    setTitle(value);
    if (!slugTouched) setSlug(slugify(value));
  }

  async function onPickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const t = toast.loading("Uploading image…");
    try {
      const url = await uploadImage(file, { folder: "help-articles" });
      editor?.chain().focus().setImage({ src: url }).run();
      toast.success("Image added", { id: t });
    } catch {
      toast.error("Upload failed", { id: t });
    }
  }

  function setLink() {
    const prev = editor?.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link URL", prev ?? "https://");
    if (url === null) return;
    if (url === "")
      editor?.chain().focus().extendMarkRange("link").unsetLink().run();
    else
      editor
        ?.chain()
        .focus()
        .extendMarkRange("link")
        .setLink({ href: url })
        .run();
  }

  async function askAi(e: React.SyntheticEvent) {
    e.preventDefault();
    const instruction = aiPrompt.trim();
    if (!instruction || aiBusy) return;
    const history = messages.slice(-6);
    setMessages((m) => [...m, { role: "user", text: instruction }]);
    setAiPrompt("");
    setAiBusy(true);
    const res = await runHelpAiCommand({
      instruction,
      currentHtml: editor?.getHTML() ?? "",
      title,
      excerpt,
      seoTitle,
      seoDescription,
      history,
    });
    setAiBusy(false);
    if (res.error || !res.data) {
      setMessages((m) => [
        ...m,
        { role: "ai", text: res.error ?? "Sorry, that didn't work." },
      ]);
      return;
    }

    // The model needs more info — surface the question, change nothing.
    if (res.data.action === "clarify") {
      setMessages((m) => [
        ...m,
        {
          role: "ai",
          text: res.data!.question ?? "Could you give me a bit more detail?",
        },
      ]);
      return;
    }

    // Apply: body + any SEO fields the model filled. Report what changed.
    const changed: string[] = [];
    if (res.data.body) {
      editor?.commands.setContent(res.data.body);
      changed.push("content");
    }
    if (res.data.excerpt) {
      setExcerpt(res.data.excerpt);
      changed.push("excerpt");
    }
    if (res.data.seoTitle) {
      setSeoTitle(res.data.seoTitle);
      changed.push("SEO title");
    }
    if (res.data.seoDescription) {
      setSeoDescription(res.data.seoDescription);
      changed.push("meta description");
    }
    setMessages((m) => [
      ...m,
      {
        role: "ai",
        text: changed.length
          ? `Updated ${changed.join(", ")} — review and edit as needed.`
          : "Done — nothing needed changing.",
      },
    ]);
  }

  function save(publish?: boolean) {
    if (!title.trim()) {
      toast.error("Title is required.");
      return;
    }
    const input: HelpArticleInput = {
      title,
      slug,
      categoryId: categoryId || null,
      excerpt,
      body: editor?.getHTML() ?? "",
      status: publish ? "published" : status,
      seoTitle,
      seoDescription,
    };
    startSave(async () => {
      const res = articleId
        ? await updateHelpArticle(articleId, input)
        : await createHelpArticle(input);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(articleId ? "Saved" : "Article created");
      router.push(BACK_HREF);
      router.refresh();
    });
  }

  return (
    <div className="hca-page">
      <div className="hca-modal">
        {/* header */}
        <div className="hca-head">
          <button
            className="hca-close"
            onClick={close}
            title="Back to articles"
          >
            <ArrowLeft size={18} />
          </button>
          <strong>{articleId ? "Edit article" : "New article"}</strong>
          <div className="hca-head-actions">
            <button
              className="hca-btn ghost"
              disabled={saving}
              onClick={() => save(false)}
            >
              Save draft
            </button>
            <button
              className="hca-btn primary"
              disabled={saving}
              onClick={() => save(true)}
            >
              {status === "published" ? "Save & keep live" : "Publish"}
            </button>
          </div>
        </div>

        <div className="hca-body">
          {/* AI assistant (left panel) */}
          <aside className="hca-ai-panel">
            <div className="hca-ai-head">
              <Sparkles size={16} />
              <span>AI assistant</span>
            </div>
            <div className="hca-ai-log">
              {messages.length === 0 ? (
                <div className="hca-ai-empty">
                  Ask me to write or edit this article. Try “Write a guide on
                  connecting a custom domain”, “make it shorter”, or “add a
                  table of DNS records”.
                </div>
              ) : (
                messages.map((m, i) => (
                  <div key={i} className={`hca-ai-msg ${m.role}`}>
                    {m.text}
                  </div>
                ))
              )}
            </div>
            <form className="hca-ai-composer" onSubmit={askAi}>
              <textarea
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                disabled={aiBusy}
                rows={3}
                placeholder="Ask AI to write or change this article…"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) askAi(e);
                }}
              />
              <button type="submit" disabled={aiBusy || !aiPrompt.trim()}>
                {aiBusy ? "Working…" : "Ask AI"}
              </button>
            </form>
          </aside>

          {/* editor */}
          <div className="hca-main">
            <div className="hca-toolbar">
              <Btn
                title="Heading"
                active={editor?.isActive("heading", { level: 2 })}
                onClick={() =>
                  editor?.chain().focus().toggleHeading({ level: 2 }).run()
                }
              >
                <Heading2 size={17} />
              </Btn>
              <Btn
                title="Subheading"
                active={editor?.isActive("heading", { level: 3 })}
                onClick={() =>
                  editor?.chain().focus().toggleHeading({ level: 3 }).run()
                }
              >
                <Heading3 size={17} />
              </Btn>
              <Btn
                title="Bold"
                active={editor?.isActive("bold")}
                onClick={() => editor?.chain().focus().toggleBold().run()}
              >
                <Bold size={17} />
              </Btn>
              <Btn
                title="Italic"
                active={editor?.isActive("italic")}
                onClick={() => editor?.chain().focus().toggleItalic().run()}
              >
                <Italic size={17} />
              </Btn>
              <Btn
                title="Underline"
                active={editor?.isActive("underline")}
                onClick={() => editor?.chain().focus().toggleUnderline().run()}
              >
                <UnderlineIcon size={17} />
              </Btn>
              <Btn
                title="Bullet list"
                active={editor?.isActive("bulletList")}
                onClick={() => editor?.chain().focus().toggleBulletList().run()}
              >
                <List size={17} />
              </Btn>
              <Btn
                title="Numbered list"
                active={editor?.isActive("orderedList")}
                onClick={() =>
                  editor?.chain().focus().toggleOrderedList().run()
                }
              >
                <ListOrdered size={17} />
              </Btn>
              <Btn
                title="Quote"
                active={editor?.isActive("blockquote")}
                onClick={() => editor?.chain().focus().toggleBlockquote().run()}
              >
                <Quote size={17} />
              </Btn>
              <Btn
                title="Divider"
                onClick={() =>
                  editor?.chain().focus().setHorizontalRule().run()
                }
              >
                <Minus size={17} />
              </Btn>
              <Btn
                title="Link"
                active={editor?.isActive("link")}
                onClick={setLink}
              >
                <LinkIcon size={17} />
              </Btn>
              <Btn title="Image" onClick={() => fileRef.current?.click()}>
                <ImageIcon size={17} />
              </Btn>
              <Btn
                title="Insert table"
                onClick={() =>
                  editor
                    ?.chain()
                    .focus()
                    .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
                    .run()
                }
              >
                <TableIcon size={17} />
              </Btn>
            </div>
            {loading ? (
              <div className="hca-loading">Loading…</div>
            ) : (
              <EditorContent editor={editor} className="hca-editor" />
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={onPickImage}
            />

            {/* Google-Docs-style floating table controls — appear next to the
                table whenever the cursor is inside one. */}
            {editor && (
              <BubbleMenu
                editor={editor}
                shouldShow={() => editor.isActive("table")}
                options={{ placement: "top", offset: 8 }}
                className="hca-table-bar"
              >
                <div className="grp">
                  <span className="lbl">Row</span>
                  <button
                    title="Insert row above"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => editor.chain().focus().addRowBefore().run()}
                  >
                    ＋↑
                  </button>
                  <button
                    title="Insert row below"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => editor.chain().focus().addRowAfter().run()}
                  >
                    ＋↓
                  </button>
                  <button
                    title="Delete row"
                    className="danger"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => editor.chain().focus().deleteRow().run()}
                  >
                    ✕
                  </button>
                </div>
                <span className="div" />
                <div className="grp">
                  <span className="lbl">Column</span>
                  <button
                    title="Insert column left"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() =>
                      editor.chain().focus().addColumnBefore().run()
                    }
                  >
                    ＋←
                  </button>
                  <button
                    title="Insert column right"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() =>
                      editor.chain().focus().addColumnAfter().run()
                    }
                  >
                    ＋→
                  </button>
                  <button
                    title="Delete column"
                    className="danger"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => editor.chain().focus().deleteColumn().run()}
                  >
                    ✕
                  </button>
                </div>
                <span className="div" />
                <button
                  title="Delete table"
                  className="danger del-table"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => editor.chain().focus().deleteTable().run()}
                >
                  Delete table
                </button>
              </BubbleMenu>
            )}
          </div>

          {/* sidebar */}
          <aside className="hca-side">
            <label className="hca-field">
              <span>Title</span>
              <input
                value={title}
                onChange={(e) => onTitleChange(e.target.value)}
                placeholder="How to connect a custom domain"
              />
            </label>
            <label className="hca-field">
              <span>URL slug</span>
              <input
                value={slug}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(slugify(e.target.value));
                }}
                placeholder="connect-custom-domain"
              />
            </label>
            <label className="hca-field">
              <span>Category</span>
              <select
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
              >
                <option value="">— None —</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="hca-field">
              <span>Excerpt</span>
              <textarea
                rows={2}
                value={excerpt}
                onChange={(e) => setExcerpt(e.target.value)}
                placeholder="One-line summary (shown in lists + meta description)."
              />
            </label>
            <label className="hca-field">
              <span>Status</span>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as HelpStatus)}
              >
                <option value="draft">Draft</option>
                <option value="published">Published</option>
              </select>
            </label>
            <div className="hca-field-group">
              <div className="hca-group-label">SEO</div>
              <label className="hca-field">
                <span>SEO title</span>
                <input
                  value={seoTitle}
                  onChange={(e) => setSeoTitle(e.target.value)}
                  placeholder={title || "Defaults to the title"}
                />
              </label>
              <label className="hca-field">
                <span>Meta description</span>
                <textarea
                  rows={2}
                  value={seoDescription}
                  onChange={(e) => setSeoDescription(e.target.value)}
                  placeholder="Defaults to the excerpt."
                />
              </label>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

-- Forward-only: no memory is created or approved by this migration.
CREATE TABLE IF NOT EXISTS public.mink_memories (
 id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
 admin_id text NOT NULL, title text NOT NULL, content text NOT NULL, kind text NOT NULL,
 version integer NOT NULL DEFAULT 1, scope_hash text NOT NULL, request_key uuid NOT NULL, request_hash text NOT NULL,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT mink_memories_text_check CHECK(char_length(title) BETWEEN 1 AND 80 AND char_length(content) BETWEEN 1 AND 600),
 CONSTRAINT mink_memories_kind_check CHECK(kind IN ('preference','brand_voice','business_context')),
 CONSTRAINT mink_memories_version_check CHECK(version > 0),
 CONSTRAINT mink_memories_hash_check CHECK(scope_hash ~ '^[a-f0-9]{64}$' AND request_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX IF NOT EXISTS mink_memories_owner_idx ON public.mink_memories(store_id,admin_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS mink_memories_expiry_idx ON public.mink_memories(expires_at);
-- Content-free deletion markers prevent delayed retries resurrecting deleted memories.
CREATE TABLE IF NOT EXISTS public.mink_memory_deletions (
 id uuid NOT NULL, store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
 admin_id text NOT NULL, deleted_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(store_id,admin_id,id)
);
ALTER TABLE public.mink_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mink_memory_deletions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mink_memories,public.mink_memory_deletions FROM PUBLIC,app_user;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.mink_memories,public.mink_memory_deletions TO app_service;

DO $memory_help$
DECLARE guidance text := $guide$<h2>Approve private memories and review text documents</h2>
<p>Open Mink AI and choose Memories in the chat header. Your memories belong only to your admin account in this store, not to every employee. You can save answer preferences, brand voice or business context. Add a title and exact text, choose 30, 90 or 365 days, tick the approval checkbox and choose Approve and save memory. You can keep up to 10 active memories, with an 80-character title and 600-character body. Do not save secrets, passwords, payment details or customer personal information. Saying &quot;remember this&quot; in chat does not save anything; Mink directs you to these controls.</p>
<p>Approved unexpired memories are included as untrusted reference data in your future chat turns. They are not live business facts, system rules, location scope or permission to act. Your current request takes precedence over a preference, and changing facts still need live tools. If your role, permissions or location bindings change, affected memories are not used until you edit and approve them again. Background watches and existing queued workflows do not receive memories. Saving has no separate credit charge; including context uses ordinary model input tokens and normal chat billing.</p>
<p>Edit lets you review the complete replacement text and renew retention. Changes in another tab cause a conflict rather than overwriting someone else's edit. Repeating the same save returns the same version. Delete removes the stored memory text; Delete all my memories affects only you in this store. Content-free deletion markers prevent old retries from recreating deleted memories. Expiry stops use immediately, even if the background worker is down; the existing workflow heartbeat removes expired text in bounded batches. Memories can still be inspected and deleted when Mink generation or invitations are disabled, provided you retain dashboard access.</p>
<p>Deletion cannot recall context already sent to an active model run or erase mentions in old conversation history. Start a new conversation and delete old conversations separately when needed. Provider retention is governed by your Vertex configuration and agreements; deleting a StoreMink memory is not a provider-data deletion request.</p>
<p>Choose Add text document near the composer for one UTF-8 .txt or .md file up to 8 KiB and 3,000 characters. The file is read locally. Review and edit the text, remove sensitive information, tick its checkbox, then choose Add reviewed text to message. Nothing is sent until you send the resulting message. The combined message must fit 4,000 characters. The reviewed text is labelled untrusted source data and retained with the conversation under its existing history/deletion rules; it is not saved as a memory, media upload or searchable document library. Markdown and instruction-like content are text, not authority to call tools or approve actions. Files cannot silently change stock, send messages or publish a storefront.</p>
<p>This input release does not support PDFs, images, screenshots, audio, voice transcription, spreadsheets, external URL fetching or automatic document processing. Paste a short text excerpt instead. Invalid encoding, binary controls and oversized files are rejected rather than silently truncated. Use Discard document to remove a local preview, or edit the composer before sending.</p>$guide$;
BEGIN
 UPDATE public.help_articles SET body=body||E'\n'||guidance,updated_at=now()
 WHERE slug='use-mink-ai-in-your-dashboard' AND status='published' AND category_id IS NOT NULL
 AND position('<h2>Approve private memories and review text documents</h2>' in body)=0;
 IF NOT EXISTS(SELECT 1 FROM public.help_articles WHERE slug='use-mink-ai-in-your-dashboard' AND status='published' AND category_id IS NOT NULL AND position(guidance in body)>0)
 THEN RAISE EXCEPTION 'Mink Phase 8D guidance was not installed; apply previous Help migrations first'; END IF;
END;
$memory_help$;

"use client";

import { useEffect, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  Archive,
  CheckCircle2,
  Clock3,
  Eye,
  Mail,
  MoreHorizontal,
  Search,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
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
import {
  deleteEnquiry,
  updateEnquiryStatus,
  type EnquiryStatus,
} from "@/app/actions/enquiry-actions";
import { ListPagination } from "../components/list-pagination";
import type { EnquirySort, EnquiryStats } from "./data";
import { DateRangePicker } from "./date-range-picker";
import {
  NO_SUBJECT,
  STATUS_ACTIONS,
  STATUS_META,
  type Enquiry,
} from "./shared";

type FilterTab = "all" | EnquiryStatus;

const SORT_OPTIONS: { key: EnquirySort; label: string }[] = [
  { key: "status", label: "Status: new first" },
  { key: "newest", label: "Newest first" },
  { key: "oldest", label: "Oldest first" },
];

const STATUS_ICONS: Record<EnquiryStatus, React.ReactNode> = {
  new: <Clock3 className="h-4 w-4" />,
  in_progress: <SlidersHorizontal className="h-4 w-4" />,
  resolved: <CheckCircle2 className="h-4 w-4" />,
  archived: <Archive className="h-4 w-4" />,
};

function initials(name: string) {
  return (
    name
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "?"
  );
}

export function EnquiriesManagementView({
  enquiries,
  canManage = true,
  stats,
  subjectOptions,
  total,
  page,
  pageSize,
  query,
  status,
  subject,
  fromDate,
  toDate,
  sort,
}: {
  enquiries: Enquiry[];
  canManage?: boolean;
  stats: EnquiryStats;
  subjectOptions: { subjects: string[]; hasNone: boolean };
  total: number;
  page: number;
  pageSize: number;
  query: string;
  status: FilterTab;
  subject: string;
  fromDate: string;
  toDate: string;
  sort: EnquirySort;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const [navigating, startNavigation] = useTransition();
  const [search, setSearch] = useState(query);
  const [deleteTarget, setDeleteTarget] = useState<Enquiry | null>(null);

  const openDetail = (enquiry: Enquiry) =>
    router.push(`/dashboard/enquiries/${enquiry.id}`);

  const hrefFor = (next: {
    q?: string;
    status?: FilterTab;
    subject?: string;
    sort?: EnquirySort;
    from?: string;
    to?: string;
    page?: number;
  }): string => {
    const q = (next.q ?? query).trim();
    const st = next.status ?? status;
    const subj = next.subject ?? subject;
    const so = next.sort ?? sort;
    const f = next.from ?? fromDate;
    const t = next.to ?? toDate;
    const changedFacet =
      next.q !== undefined ||
      next.status !== undefined ||
      next.subject !== undefined ||
      next.sort !== undefined ||
      next.from !== undefined ||
      next.to !== undefined;
    const p = next.page ?? (changedFacet ? 1 : page);

    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (st !== "all") params.set("status", st);
    if (subj) params.set("subject", subj);
    if (so !== "status") params.set("sort", so);
    if (f) params.set("from", f);
    if (t) params.set("to", t);
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };

  const go = (next: Parameters<typeof hrefFor>[0]) =>
    startNavigation(() => router.push(hrefFor(next)));

  useEffect(() => {
    if (search.trim() === query.trim()) return;
    const handle = setTimeout(() => {
      startNavigation(() => router.push(hrefFor({ q: search })));
    }, 400);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const anyFilterActive =
    !!query.trim() || status !== "all" || !!subject || !!fromDate || !!toDate;

  const handleStatus = (enquiry: Enquiry, next: EnquiryStatus) => {
    startTransition(async () => {
      const result = await updateEnquiryStatus(enquiry.id, next);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success(`Marked as ${STATUS_META[next].label.toLowerCase()}`);
      router.refresh();
    });
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    startTransition(async () => {
      const result = await deleteEnquiry(deleteTarget.id);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success("Enquiry deleted");
      setDeleteTarget(null);
      router.refresh();
    });
  };

  const formatDate = (value: string) =>
    new Date(value).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });

  const replyMailto = (enquiry: Enquiry) =>
    `mailto:${enquiry.email}?subject=${encodeURIComponent(
      `Re: ${enquiry.subject?.trim() || "Your enquiry"}`,
    )}`;

  const rangeFrom = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeTo = Math.min(page * pageSize, total);

  const metrics: { key: EnquiryStatus; label: string; value: number }[] = [
    { key: "new", label: "New", value: stats.new },
    { key: "in_progress", label: "In progress", value: stats.in_progress },
    { key: "resolved", label: "Resolved", value: stats.resolved },
    { key: "archived", label: "Archived", value: stats.archived },
  ];

  return (
    <div className="dash-page-enter enquiries-workspace">
      <header className="dash-page-header row enquiries-header">
        <div>
          <h1>Enquiries</h1>
          <p>Messages submitted through the storefront enquiry form</p>
        </div>
        <div className="enquiries-total">
          <span>{stats.all}</span>
          <small>Total</small>
        </div>
      </header>

      <section
        className="enquiries-metrics"
        aria-label="Enquiry status summary"
      >
        {metrics.map((metric) => (
          <button
            key={metric.key}
            type="button"
            className={`enquiry-metric enquiry-metric-${metric.key}${
              status === metric.key ? " active" : ""
            }`}
            aria-pressed={status === metric.key}
            onClick={() =>
              go({ status: status === metric.key ? "all" : metric.key })
            }
          >
            <span className="enquiry-metric-icon">
              {STATUS_ICONS[metric.key]}
            </span>
            <span>
              <strong>{metric.value}</strong>
              <small>{metric.label}</small>
            </span>
          </button>
        ))}
      </section>

      <section className="enquiries-command">
        <label className="enquiries-search">
          <Search className="h-4 w-4" />
          <input
            type="text"
            placeholder="Search name, email, message..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>

        <select
          aria-label="Order by"
          value={sort}
          onChange={(event) => go({ sort: event.target.value as EnquirySort })}
          className="enquiries-select"
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>
      </section>

      <section className="enquiries-filters">
        <select
          aria-label="Filter by subject"
          value={subject}
          onChange={(event) => go({ subject: event.target.value })}
          className="enquiries-select enquiries-subject-select"
        >
          <option value="">All subjects</option>
          {subjectOptions.subjects.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
          {subjectOptions.hasNone && (
            <option value={NO_SUBJECT}>(No subject)</option>
          )}
        </select>

        <div className="enquiries-date-range">
          <span>Received</span>
          <DateRangePicker
            value={{ from: fromDate, to: toDate }}
            onChange={(next) => go({ from: next.from, to: next.to })}
          />
        </div>

        {anyFilterActive && (
          <button
            type="button"
            className="dash-btn dash-btn-ghost dash-btn-sm"
            onClick={() => {
              setSearch("");
              startNavigation(() => router.push(pathname));
            }}
          >
            Clear
          </button>
        )}
      </section>

      <div className="dash-card enquiries-table-card">
        <div className="dash-card-header enquiries-table-head">
          <div>
            <div className="dash-card-title">Inbox</div>
            <div className="dash-card-sub">
              {total === 0
                ? "No messages"
                : `Showing ${rangeFrom}–${rangeTo} of ${total}`}
              {navigating ? " · updating…" : ""}
            </div>
          </div>
        </div>

        {enquiries.length === 0 ? (
          <div className="enquiries-empty">
            <div>No enquiries found</div>
            <p>
              {anyFilterActive
                ? "Adjust the filters or search term."
                : "New storefront messages will appear here."}
            </p>
          </div>
        ) : (
          <div className="enquiries-table-wrap">
            <table className="dash-table dash-table-wide enquiries-table">
              <thead>
                <tr>
                  <th>From</th>
                  <th>Phone</th>
                  <th>Subject</th>
                  <th>Message</th>
                  <th>Status</th>
                  <th>Received</th>
                  {canManage && <th className="dash-col-actions" />}
                </tr>
              </thead>
              <tbody>
                {enquiries.map((enquiry) => (
                  <tr
                    key={enquiry.id}
                    onClick={() => openDetail(enquiry)}
                    title="View full enquiry"
                  >
                    <td>
                      <div className="enquiries-person">
                        <span>{initials(enquiry.name)}</span>
                        <div>
                          <strong>{enquiry.name}</strong>
                          <a
                            href={replyMailto(enquiry)}
                            onClick={(event) => event.stopPropagation()}
                          >
                            {enquiry.email}
                          </a>
                        </div>
                      </div>
                    </td>

                    <td className="text-muted font-mono-dash enquiries-phone">
                      {enquiry.phone}
                    </td>

                    <td
                      className="text-muted enquiries-subject"
                      title={enquiry.subject ?? undefined}
                    >
                      {enquiry.subject?.trim() || "-"}
                    </td>

                    <td className="enquiries-message">
                      <span>{enquiry.message}</span>
                    </td>

                    <td>
                      <span
                        className={`dash-badge ${STATUS_META[enquiry.status].badge}`}
                      >
                        {STATUS_META[enquiry.status].label}
                      </span>
                    </td>

                    <td className="text-dim font-mono-dash enquiries-date">
                      {formatDate(enquiry.created_at)}
                    </td>

                    {canManage && (
                      <td
                        className="dash-col-actions"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <DropdownMenu>
                          <DropdownMenuTrigger className="enquiries-row-menu">
                            <MoreHorizontal className="h-4 w-4" />
                            <span className="sr-only">Actions</span>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="end"
                            className="min-w-[190px]"
                          >
                            <DropdownMenuItem
                              className="cursor-pointer"
                              onClick={() => openDetail(enquiry)}
                            >
                              <Eye className="mr-2 h-4 w-4" />
                              View details
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="cursor-pointer"
                              onClick={() =>
                                window.open(replyMailto(enquiry), "_blank")
                              }
                            >
                              <Mail className="mr-2 h-4 w-4" />
                              Reply via email
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            {STATUS_ACTIONS.filter(
                              (action) => action.status !== enquiry.status,
                            ).map((action) => (
                              <DropdownMenuItem
                                key={action.status}
                                className="cursor-pointer"
                                onClick={() =>
                                  handleStatus(enquiry, action.status)
                                }
                                disabled={isPending}
                              >
                                <span className="mr-2 inline-flex h-4 w-4 items-center justify-center">
                                  {STATUS_ICONS[action.status]}
                                </span>
                                Mark as{" "}
                                {STATUS_META[action.status].label.toLowerCase()}
                              </DropdownMenuItem>
                            ))}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="cursor-pointer text-[#dc2626] focus:text-[#dc2626]"
                              onClick={() => setDeleteTarget(enquiry)}
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
          </div>
        )}

        <ListPagination
          page={page}
          total={total}
          pageSize={pageSize}
          busy={navigating}
          onPage={(p) => go({ page: p })}
        />
      </div>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent className="enquiry-confirm-dialog sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Delete enquiry</DialogTitle>
            <DialogDescription>
              Delete the enquiry from {deleteTarget?.name}? This action cannot
              be undone.
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
    </div>
  );
}

"use client";

// The Import / Export control that sits in a list page's toolbar.
//
// Placed on each resource's OWN page rather than behind one central
// "Import/Export" destination, which is where Shopify puts it and why: a
// merchant looking at their product list and wanting a copy of it should not
// have to go somewhere else, pick "products" from a menu, and come back. The
// central page that DOES exist is the history — Activity logs → Imports &
// exports — because that is a question about the past, not an action.

import { useState } from "react";
import { Download, MoreHorizontal, Upload } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getResource } from "@/lib/import-export/resources";
import type { ResourceId } from "@/lib/import-export/types";
import { ImportDialog } from "./import-dialog";

/** Trigger a download without leaving the page. The response is an attachment,
 *  so the browser saves it and the current view is untouched. */
function download(href: string) {
  window.location.href = href;
}

export interface ImportExportMenuProps {
  resource: ResourceId;
  /**
   * The caller may `manage` this resource. Import is hidden without it — the
   * server refuses either way, but a control that always fails is worse than
   * no control.
   */
  canImport?: boolean;
  /** Carried into the export URL so a filtered list exports what it shows. */
  filters?: Record<string, string | undefined>;
  locations?: { id: string; name: string }[];
}

export function ImportExportMenu({
  resource: resourceId,
  canImport = false,
  filters,
  locations,
}: ImportExportMenuProps) {
  const [importOpen, setImportOpen] = useState(false);
  const resource = getResource(resourceId);
  if (!resource) return null;

  const params = new URLSearchParams({ resource: resource.id });
  let isFiltered = false;
  for (const [key, value] of Object.entries(filters ?? {})) {
    if (!value || value === "all") continue;
    params.set(key, value);
    isFiltered = true;
  }
  const exportHref = `/api/dashboard/export?${params.toString()}`;

  const showImport = canImport && resource.canImport;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="dash-btn dash-btn-ghost"
          aria-label={`Import or export ${resource.noun}`}
        >
          <MoreHorizontal className="h-4 w-4" />
          <span className="hidden sm:inline">Import / Export</span>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" className="min-w-[220px]">
          {showImport ? (
            <>
              <DropdownMenuItem
                className="cursor-pointer"
                onClick={() => setImportOpen(true)}
              >
                <Upload className="mr-2 h-4 w-4" />
                Import {resource.noun}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}

          {/* A plain navigation, not a fetch: the response carries
              Content-Disposition: attachment, so the browser downloads it
              natively — save dialog, progress, resumability — and never leaves
              this page. Fetching it instead would mean buffering the whole
              file in memory to hand to a blob URL, which is the thing the
              streaming route exists to avoid. */}
          <DropdownMenuItem
            className="cursor-pointer"
            onClick={() => download(exportHref)}
          >
            <Download className="mr-2 h-4 w-4" />
            Export {resource.noun}
            {isFiltered ? " (filtered)" : ""}
          </DropdownMenuItem>

          {showImport ? (
            <DropdownMenuItem
              className="cursor-pointer"
              onClick={() =>
                download(
                  `/api/dashboard/export?resource=${resource.id}&template=1`,
                )
              }
            >
              <Download className="mr-2 h-4 w-4" />
              Download a blank template
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {showImport ? (
        <ImportDialog
          resource={resource.id}
          open={importOpen}
          onOpenChange={setImportOpen}
          locations={locations}
        />
      ) : null}
    </>
  );
}

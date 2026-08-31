import "server-only";

import { and, asc, eq, inArray } from "drizzle-orm";
import { storeLocations } from "@/drizzle/schema";
import { withUser } from "@/lib/db/client";
import { MinkToolInputError } from "../errors";
import type { MinkActorContext } from "../types";

export interface MinkResolvedLocation {
  locationIds: string[] | null;
  selectedId: string | null;
  label: string;
  includeUnassigned: boolean;
  availableLocations: MinkAccessibleLocation[];
}

export interface MinkAccessibleLocation {
  id: string;
  name: string;
  type: string;
}

/** Intersect a model-supplied location NAME with the trusted actor scope. */
export async function resolveMinkLocation(
  actor: MinkActorContext,
  requestedValue: unknown,
): Promise<MinkResolvedLocation> {
  const requested = optionalLocationName(requestedValue);
  const options =
    actor.locationIds?.length === 0
      ? []
      : await withUser({ uid: actor.adminId, email: actor.email }, (db) =>
          db
            .select({
              id: storeLocations.id,
              name: storeLocations.name,
              type: storeLocations.type,
            })
            .from(storeLocations)
            .where(
              and(
                eq(storeLocations.storeId, actor.storeId),
                eq(storeLocations.active, true),
                ...(actor.locationIds
                  ? [inArray(storeLocations.id, actor.locationIds)]
                  : []),
              ),
            )
            .orderBy(asc(storeLocations.sortOrder), asc(storeLocations.name)),
        );

  if (requested) {
    const requestedName = normalize(requested);
    const matches = options.filter((option) =>
      locationAliases(option.name, option.type).has(requestedName),
    );
    if (matches.length !== 1) {
      throw new MinkToolInputError(
        matches.length > 1
          ? "location_name is ambiguous; ask the user to choose the exact dashboard location."
          : "location_name does not match an accessible dashboard location.",
      );
    }
    return {
      locationIds: [matches[0].id],
      selectedId: matches[0].id,
      label: matches[0].name,
      includeUnassigned: false,
      availableLocations: options,
    };
  }

  if (actor.locationIds === null) {
    return {
      locationIds: null,
      selectedId: null,
      label: "All store locations",
      includeUnassigned: true,
      availableLocations: options,
    };
  }
  return {
    locationIds: [...actor.locationIds],
    selectedId: null,
    label:
      options.length === 0
        ? "No assigned active locations"
        : `${options.length} assigned ${options.length === 1 ? "location" : "locations"}`,
    includeUnassigned: true,
    availableLocations: options,
  };
}

function optionalLocationName(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new MinkToolInputError("location_name must be a string.");
  }
  const name = value.trim();
  if (!name || name.length > 100) {
    throw new MinkToolInputError(
      "location_name must be between 1 and 100 characters.",
    );
  }
  return name;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-IN");
}

/**
 * Accept the canonical dashboard name or that name paired with its displayed
 * location type. The alias still has to resolve to exactly one accessible row;
 * this is intentionally not fuzzy matching.
 */
function locationAliases(name: string, type: string): Set<string> {
  const normalizedName = normalize(name);
  const normalizedType = normalize(type.replaceAll("_", " "));
  return new Set([
    normalizedName,
    `${normalizedName} ${normalizedType}`,
    `${normalizedType} ${normalizedName}`,
  ]);
}

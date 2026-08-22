/** Build a tenant-owned GCS path for uploads that are not media-library rows. */
export function storeUploadPath(
  storeId: string | null,
  folder: string,
  fileName: string,
): string {
  const cleanFolder = folder
    .replace(/[^a-z0-9/_-]/gi, "")
    .split("/")
    .filter(Boolean)
    .join("/");
  const root = storeId ? `stores/${storeId}/uploads` : "platform/uploads";
  return cleanFolder
    ? `${root}/${cleanFolder}/${fileName}`
    : `${root}/${fileName}`;
}

/** Every GCS object created for a store lives below this prefix going forward. */
export function storeStoragePrefix(storeId: string): string {
  return `stores/${storeId}/`;
}

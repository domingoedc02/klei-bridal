import { derivativePaths } from "./variants";

export function missingDerivativePaths(
  rows: Array<{ originalPath: string }>,
  onDisk: Set<string>,
): string[] {
  return rows.flatMap(({ originalPath }) =>
    derivativePaths(originalPath).filter((path) => !onDisk.has(path)),
  );
}

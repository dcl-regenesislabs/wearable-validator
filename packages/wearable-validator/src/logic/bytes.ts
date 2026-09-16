/** Byte-count formatting shared by the size-limit checks. */

/** Bytes → MiB rounded to two decimals, as creators read limits. */
export const mb = (n: number): number => Math.round((n / 1048576) * 100) / 100;

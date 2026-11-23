// Convert only complete unsigned decimal strings. Preserve malformed values so
// validation rejects them instead of coercing arrays, blanks, fractions or NaN.
export function parsePaginationInteger({ value }: { value: unknown }): unknown {
  return typeof value === 'string' && value.length > 0 && !/[^0-9]/.test(value)
    ? Number(value)
    : value;
}

export function trimQueryFilter({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

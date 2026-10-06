/** Pure date helper for tenancy notices. */
export function addDays(from: string | Date, days: number): Date {
  return new Date(new Date(from).getTime() + days * 86_400_000);
}

export function titleCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

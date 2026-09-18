/**
 * Whether a nav item is the current section. The root only matches itself — otherwise
 * Cook would light up on every page — and a prefix only counts on a segment boundary.
 */
export function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

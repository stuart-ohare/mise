"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { isActive } from "./nav-active";

const items = [
  { href: "/", label: "Cook" },
  { href: "/intake", label: "Intake" },
  { href: "/review", label: "Review" },
] as const;

export default function Nav() {
  const pathname = usePathname();
  return (
    <ul className="flex gap-1 rounded-full border border-border bg-surface-muted p-1 text-sm">
      {items.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={
                active
                  ? "block rounded-full bg-surface px-3.5 py-1 font-medium text-foreground shadow-sm"
                  : "block rounded-full px-3.5 py-1 text-muted transition-colors hover:text-foreground"
              }
            >
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

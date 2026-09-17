import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

// System font stack rather than next/font/google: it keeps the build hermetic
// (no network fetch at build time) and costs nothing at this scope.

export const metadata: Metadata = {
  title: "Mise",
  description:
    "What can I actually cook right now — where a dietary exclusion is a database constraint, not a model decision.",
};

const nav = [
  { href: "/", label: "Cook" },
  { href: "/intake", label: "Intake" },
  { href: "/review", label: "Review" },
] as const;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="bg-background text-foreground flex min-h-full flex-col">
        <header className="border-b border-black/10 dark:border-white/15">
          <nav className="mx-auto flex max-w-3xl items-baseline gap-6 px-4 py-4">
            <Link href="/" className="font-semibold tracking-tight">
              Mise
            </Link>
            <ul className="flex gap-4 text-sm">
              {nav.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className="opacity-70 hover:opacity-100">
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </header>
        <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10">{children}</main>
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import Link from "next/link";

import Nav from "./_components/nav";
import "./globals.css";

// System font stack rather than next/font/google: it keeps the build hermetic
// (no network fetch at build time) and costs nothing at this scope.

export const metadata: Metadata = {
  title: "Mise",
  description:
    "What can I actually cook right now — where a dietary exclusion is a database constraint, not a model decision.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="bg-background text-foreground flex min-h-full flex-col">
        <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur">
          <nav className="mx-auto flex max-w-3xl items-center justify-between gap-6 px-4 py-3">
            <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
              <span
                aria-hidden
                className="grid size-7 place-items-center rounded-lg bg-accent text-sm text-accent-fg shadow-sm"
              >
                M
              </span>
              Mise
            </Link>
            <Nav />
          </nav>
        </header>
        <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10">{children}</main>
      </body>
    </html>
  );
}

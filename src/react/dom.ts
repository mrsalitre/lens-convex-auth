import * as React from "react"

export function useMediaQuery(query: string): boolean {
  return React.useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(query)
      media.addEventListener("change", onChange)
      return () => media.removeEventListener("change", onChange)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}

// The page's theme: a `dark` or `light` class on <html> (as next-themes and shadcn set it), otherwise
// the system preference.
function readTheme(): "light" | "dark" {
  const classes = document.documentElement.classList
  if (classes.contains("dark")) return "dark"
  if (classes.contains("light")) return "light"
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

export function useDocumentTheme(): "light" | "dark" {
  return React.useSyncExternalStore(
    (onChange) => {
      const observer = new MutationObserver(onChange)
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
      const media = window.matchMedia("(prefers-color-scheme: dark)")
      media.addEventListener("change", onChange)
      return () => {
        observer.disconnect()
        media.removeEventListener("change", onChange)
      }
    },
    readTheme,
    () => "light",
  )
}

import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * The text of a caught error, without the "Error: " that `String(e)` puts in
 * front of every `Error` — which every command rejection is (#804).
 */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
